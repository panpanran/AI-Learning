# Diagnostic 出题质量评估方案

> 版本：v1.0  
> 状态：设计稿（待实现）  
> 适用范围：`maxailearning` 诊断出题（5 题 MCQ batch）

---

## 1. 背景与问题

### 1.1 当前实现

诊断成功后，后端异步触发两条评估链路：

```
诊断 5 题返回
  → ragas/buffer.jsonl（样本）
  → Python evaluate_ragas.py → ragas/audit_log.jsonl
  → LangWatch evaluators → app.langwatch.ai trace
```

样本由 `backend/lib/ragasSamples.js` 构建，字段映射如下：

| 评估字段 | 来源 |
|----------|------|
| `question` | 题干（`content_cn` / `content_en`，按 `lang`） |
| `answer` | 正确答案 |
| `contexts` | 关联 KP 的 `name_*` + `description` |
| `ground_truth` | `explanation_*`，无则用 `answer` |

当前使用的 Ragas 指标：

- `faithfulness`
- `answer_relevancy`
- `context_precision`
- `context_recall`

### 1.2 为什么不贴合 Diagnostic

Diagnostic **不是 RAG 问答**，而是 **LLM 按知识点计划生成 MCQ**：

```
knowledge_points（DB）
  + knowledge_point_ids_plan（分配计划）
  + grade_guidance + prompts
        ↓
   GPT 生成 5 道 MCQ
        ↓
   metadata 去重 + 入库
```

| RAG 指标假设 | Diagnostic 现实 | 结果 |
|--------------|-----------------|------|
| `contexts` = 检索到的文档片段 | `contexts` = KP 一行考纲描述 | faithfulness 长期偏低 |
| 答案应能从 context 推导 | 答案来自 LLM 出题逻辑 + 学科知识 | 0 分不代表题差 |
| precision/recall 比较检索质量 | 没有向量检索步骤 | 分数无业务含义 |

**结论：** 应保留「异步质量审计」架构，但 **换掉指标定义与 context 构造方式**，使其衡量「诊断题是否出得好」，而不是「RAG 检索是否准」。

---

## 2. 评估目标（Diagnostic 专属）

一次 diagnostic batch（5 题）应从以下维度被评估：

| 维度 | 业务问题 | 优先级 |
|------|----------|--------|
| **KP 对齐** | 题目是否考查了分配的 `knowledge_point_id`？ | P0 |
| **答案正确性** | 标答是否在选项中、是否真正确？ | P0 |
| **题答相关** | 答案是否回应题干？ | P0 |
| **选项质量** | 干扰项是否错误但合理？ | P1 |
| **双语一致** | `content/answer/explanation` 中英文是否语义一致？ | P1 |
| **难度/年级** | 是否符合 `grade_guidance`？ | P1 |
| **批次多样** | 5 题 KP 分布、metadata 是否过于重复？ | P2 |
| **结构化合规** | MCQ 4 选项、metadata 形状、必填字段 | P0（规则，非 LLM） |

---

## 3. 推荐指标集

### 3.1 分层设计

```
Layer A — 规则校验（零成本，同步可做）
Layer B — LLM-as-Judge（异步，按题评估）
Layer C — 批次聚合（5 题一组）
Layer D — 可选观测（LangWatch dashboard）
```

### 3.2 Layer A：规则校验（Deterministic）

在 `reportDiagnosticQuality` 之前或之内先做，**不调用 OpenAI**。

| 指标 ID | 检查项 | Pass 条件 |
|---------|--------|-----------|
| `schema_valid` | JSON 结构 | `type=mcq`，options 各 4 个，必填字段齐全 |
| `answer_in_options` | 标答 ∈ 选项 | `answer_*` 与 `options.*` 精确或规范化匹配 |
| `single_correct` | 唯一正确项 | 选项中仅一个与标答匹配（允许大小写/空白归一） |
| `kp_assigned` | KP 已绑定 | `knowledge_point_id` 非空且在 `allowedKnowledgePointIds` 内 |
| `kp_plan_match` | 计划一致 | 第 i 题 `knowledge_point_id === plan[i]`（若有 plan） |
| `metadata_present` | 去重特征 | `metadata` 非空；数学题符合 prompts 约定 shape |
| `bilingual_present` | 双语完整 | cn/en 的 content、options、answer、explanation 均非空 |

**输出：** 每题 `rule_checks: { id: pass/fail, details? }`，批次 `rule_pass_rate`。

> 数学科可追加：`math_answer_verifiable` — 对 `metadata.nums` + `metadata.type` 用确定性脚本验算（加减乘除等）。

### 3.3 Layer B：LLM-as-Judge（Diagnostic 核心）

每条样本扩展 **评估上下文** `eval_context`（见 §4），再跑下列 judge。

| 指标 ID | LangWatch / 实现 | 输入 | 含义 | 分数 |
|---------|------------------|------|------|------|
| `kp_alignment` | `langevals/llm_score` 或自定义 prompt | question + eval_context + kp_id | 题目是否在测该 KP | 0–1 |
| `answer_relevancy` | `ragas/response_relevancy`（保留） | question + answer | 答案是否切题 | 0–1 |
| `explanation_support` | `langevals/llm_boolean` | question + answer + explanation | 解析是否支持标答 | pass/fail |
| `distractor_quality` | `langevals/llm_score` | question + options + answer | 干扰项是否合理 | 0–1 |
| `grade_fit` | `langevals/llm_score` | question + grade_guidance | 难度是否适合年级 | 0–1 |
| `bilingual_consistency` | `langevals/llm_boolean` | content_cn/en, answer_cn/en | 双语语义一致 | pass/fail |

**明确移除（Diagnostic 默认不跑）：**

- `ragas/faithfulness`（除非 §4.2 升级为 rich context）
- `ragas/context_precision` / `ragas/context_recall`（无真实检索链路）

**可选保留（调试 RAG 未来能力时）：** 若以后 `retrieval_snippets` 非空，再启用 faithfulness 子集。

#### Judge Prompt 要点（`kp_alignment` 示例）

```
Given:
- Knowledge point: {kp_name}, unit: {unit_name}, description: {description}
- Question: {question}

Score 0–1: Does this MCQ primarily assess the listed knowledge point?
Penalize if the question tests a different skill or generic trivia.
Return JSON: { "score": number, "reason": string }
```

### 3.4 Layer C：批次级指标

对一次 diagnostic 的 5 题聚合：

| 指标 ID | 计算方式 |
|---------|----------|
| `kp_coverage` | 不同 `knowledge_point_id` 数量 / 5 |
| `kp_plan_adherence` | 与 plan 一致题数 / 5 |
| `metadata_diversity` | 5 题 metadata 两两相似度均值（已有 dedupe 逻辑可复用） |
| `batch_mean_kp_alignment` | 5 题 `kp_alignment` 均值 |
| `batch_rule_pass_rate` | Layer A 全通过题数 / 5 |

**告警阈值（建议初值）：**

| 指标 | 黄 | 红 |
|------|----|----|
| `batch_rule_pass_rate` | < 1.0 | < 0.8 |
| `batch_mean_kp_alignment` | < 0.7 | < 0.5 |
| `answer_in_options` 失败 | 任 1 题 | — |
| `kp_plan_adherence` | < 1.0 | < 0.6 |

### 3.5 Layer D：LangWatch 观测

Trace 结构建议：

```
diagnostic-generate（span）
  ├── diagnostic-batch-rules（Layer A 汇总）
  ├── diagnostic-q1-kp_alignment
  ├── diagnostic-q1-answer_relevancy
  ├── ...
  └── diagnostic-batch-summary（Layer C）
```

LangWatch evaluators 清单（v1）：

```javascript
const DIAGNOSTIC_EVALUATORS = [
  'ragas/response_relevancy',           // 保留
  // 以下需 LangWatch 自定义 evaluator 或 langevals/*
  'langevals/llm_score',                // kp_alignment, distractor_quality, grade_fit
  'langevals/llm_boolean',              // explanation_support, bilingual_consistency
];
```

---

## 4. 数据模型

### 4.1 扩展 `buildRagasSamples` → `buildDiagnosticEvalSamples`

新函数返回结构（向后兼容可保留旧字段名）：

```javascript
{
  // 现有
  question: string,
  answer: string,
  ground_truth: string,      // explanation

  // 新增
  knowledge_point_id: number,
  options: string[],         // 当前 lang 的 4 个选项
  options_zh: string[],
  options_en: string[],
  content_cn: string,
  content_en: string,
  metadata: object,

  // 评估专用上下文（非 RAG retrieval）
  eval_context: {
    kp_id: number,
    kp_name: string,
    unit_name: string,
    description: string,
    grade_level: number | null,
    subject_code: string | null,
    grade_guidance: string,  // 实际传入 prompt 的片段
  },

  // 可选：未来 retrieval_snippets 非空时填入
  retrieval_snippets: string[],
}
```

### 4.2 `eval_context` 与旧 `contexts` 的关系

| 字段 | 用途 |
|------|------|
| `eval_context` | Diagnostic LLM judge（KP 对齐、年级适配） |
| `contexts`（deprecated） | 仅兼容旧 audit；默认 **不再** 用于 faithfulness |
| `retrieval_snippets` | 若启用 Pinecone 片段，才用于 faithfulness |

**`eval_context` 拼接示例（中文）：**

```
单元：名著节选
知识点：中心思想
描述：提炼中心与作者情感
年级要求：{grade_guidance 摘要}
```

比单行 `name: description` 信息更足，但仍 **不假装是 RAG 文档**。

### 4.3 audit_log.jsonl 新格式（v2）

```json
{
  "batch_id": "uuid",
  "at": "ISO8601",
  "schema_version": 2,
  "question_count": 5,
  "lang": "zh",
  "meta": { "userId": 1, "gradeId": 7, "subjectId": 2 },
  "batch": {
    "kp_coverage": 1.0,
    "kp_plan_adherence": 1.0,
    "rule_pass_rate": 1.0,
    "mean_kp_alignment": 0.86,
    "mean_answer_relevancy": 0.82
  },
  "rows": [
    {
      "knowledge_point_id": 42,
      "question": "...",
      "answer": "...",
      "rules": { "answer_in_options": true, "kp_assigned": true },
      "scores": {
        "kp_alignment": 0.9,
        "answer_relevancy": 0.85,
        "distractor_quality": 0.8,
        "explanation_support": true
      }
    }
  ],
  "status": "ok"
}
```

---

## 5. 架构与代码改动计划

### 5.1 文件职责

| 文件 | 变更 |
|------|------|
| `backend/lib/ragasSamples.js` | 重命名或新增 `buildDiagnosticEvalSamples()` |
| `backend/lib/diagnosticEvalRules.js` | **新建** Layer A 规则校验 |
| `backend/lib/diagnosticEvalJudge.js` | **新建** Layer B LLM judge（OpenAI 直调或 LangWatch） |
| `backend/lib/langwatchReporter.js` | 换 evaluator 列表；传 `eval_context` 而非假 RAG context |
| `backend/lib/ragasAuditor.js` | 调用 v2 Python 或 Node judge；写 audit_log v2 |
| `ragas/evaluate_ragas.py` | v2：仅 `answer_relevancy` + 自定义 judge script；去掉 faithfulness/precision/recall 默认 |
| `ragas/README.md` | 更新指标说明 |

### 5.2 执行顺序（异步，不阻塞 HTTP）

```
reportDiagnosticQuality()
  1. buildDiagnosticEvalSamples()
  2. runDiagnosticRules()           → 即时，写 rules 结果
  3. queueDiagnosticJudge()         → OpenAI / LangWatch
  4. mergeBatchMetrics()            → audit_log.jsonl v2
  5. queueLangWatchTrace()          → 可选，Layer D
```

### 5.3 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `RAGAS_AUDIT` | `1` | 总开关 |
| `DIAG_EVAL_RULES` | `1` | Layer A |
| `DIAG_EVAL_LLM` | `1` | Layer B |
| `DIAG_EVAL_MODEL` | `gpt-4o-mini` | Judge 模型 |
| `LANGWATCH_API_KEY` | — | Layer D 可选 |
| `DIAG_EVAL_METRICS` | 见下 | 逗号分隔启用的 judge |

默认 `DIAG_EVAL_METRICS`：

```
kp_alignment,answer_relevancy,explanation_support,distractor_quality
```

---

## 6. 与现有 Ragas 指标对照

| 旧指标 | 问题 | 新方案 |
|--------|------|--------|
| faithfulness | KP 一行描述撑不住答案 | 移除；或改为 `explanation_support` |
| answer_relevancy | 仍适用 | **保留** |
| context_precision | 无检索 | 移除；用 `kp_alignment` 替代 |
| context_recall | 无检索 | 移除；用 `kp_plan_adherence`（规则）替代 |

---

## 7. 实施阶段

### Phase 1 — 快速止血（1–2 天）

- [x] Layer A 规则校验 + audit_log 写入 `rules`
- [x] LangWatch：去掉 faithfulness / context_precision / context_recall
- [x] LangWatch：仅保留 `response_relevancy`
- [x] 文档更新 `ragas/README.md` 避免误导

### Phase 2 — Diagnostic Judge（3–5 天）

- [x] `buildDiagnosticEvalSamples` + `eval_context`
- [x] 实现 `kp_alignment`、`explanation_support`、`distractor_quality`（OpenAI structured output）
- [x] audit_log v2 + `scores` / `judge_reasons` / 批次均值
- [x] LangWatch trace output 包含 judge 结果（本地 OpenAI judge，非 langevals 依赖）

### Phase 3 — 批次洞察（可选）

- [ ] 批次 dashboard 聚合字段
- [ ] 低分 batch 告警（日志或 webhook）
- [ ] 数学科 `math_answer_verifiable` 确定性验算

---

## 8. 如何解读分数（给产品/运营）

| 场景 | 解读 |
|------|------|
| `kp_alignment` 低 | 题偏离分配知识点，需改 prompt 或 KP 描述 |
| `answer_relevancy` 低 | 答案跑题，严重质量问题 |
| `answer_in_options` 失败 | 硬错误，必须拦截或重生成 |
| `distractor_quality` 低 | 干扰项太假或含多个正确项 |
| `rule_pass_rate` = 1 但 judge 低 | 结构合法但 pedagogical 质量差 |
| 旧 faithfulness = 0 | **可忽略**（指标不适用） |

---

## 9. 附录

### 9.1 当前代码锚点

- 样本构建：`backend/lib/ragasSamples.js`
- 质量上报：`backend/routes/diagnostic.js` → `reportDiagnosticQuality()`
- LangWatch：`backend/lib/langwatchReporter.js`
- Python 审核：`ragas/evaluate_ragas.py`
- 出题 prompt：`backend/lib/prompts.js` → `diagnostic.*`

### 9.2 参考

- [LangWatch Evaluators List](https://langwatch.ai/docs/evaluations/evaluators/list)
- [Ragas Metrics](https://docs.ragas.io/) — 适用于 RAG QA，非本场景默认集

---

## 10. 决策记录

| 日期 | 决策 |
|------|------|
| 2026-07-04 | 放弃将 KP `description` 当作 RAG `contexts` 跑 faithfulness |
| 2026-07-04 | Diagnostic 核心质量 = KP 对齐 + 答案/选项正确 + 题答相关 |
| 2026-07-04 | 保留异步 audit 架构；替换指标定义与样本 schema |
