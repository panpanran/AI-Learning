# Diagnostic 质量审核（Phase 1 + Phase 2）

每次诊断生成 **5 道题** 并返回给前端后，后端会**异步**跑质量审核（不阻塞用户等待）。

> 完整设计见 [`specs/diagnostic-quality-evaluation.md`](../specs/diagnostic-quality-evaluation.md)

## 流程

```
诊断 5 题返回
       ↓ (后台)
Layer A 规则校验（即时，无 LLM）
       ↓
Layer B LLM Judge（kp_alignment / explanation_support / distractor_quality）
       ↓
Python evaluate_ragas.py（仅 answer_relevancy）
       ↓
写入 audit_log.jsonl（schema_version: 2）
       ↓
LangWatch（可选，response_relevancy + rules/judge 摘要）
```

## 首次安装 Python 依赖

```powershell
cd maxailearning\ragas
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

需要 `OPENAI_API_KEY`（与主项目相同，读 `AI Learning\.env.local`）。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `RAGAS_AUDIT` | `1` | 关闭则跳过 Python `answer_relevancy` |
| `DIAG_EVAL_RULES` | `1` | 关闭则跳过 Layer A 规则校验 |
| `DIAG_EVAL_LLM` | `1` | 关闭则跳过 Layer B LLM judge |
| `DIAG_EVAL_METRICS` | 见下 | 逗号分隔启用的 judge 指标 |
| `DIAG_EVAL_MODEL` | `gpt-4o-mini` | Layer B judge 模型 |
| `LANGWATCH_API_KEY` | — | 配置后启用 LangWatch trace |

默认 `DIAG_EVAL_METRICS`：

```
kp_alignment,explanation_support,distractor_quality
```

## 查看审核结果

打开 **`ragas/audit_log.jsonl`**，Phase 1 起每行格式如下：

```json
{
  "schema_version": 2,
  "batch_id": "...",
  "at": "2026-07-04T...",
  "question_count": 5,
  "lang": "zh",
  "meta": { "userId": 1, "gradeId": 7, "subjectId": 2 },
  "batch": {
    "rule_pass_rate": 1.0,
    "kp_coverage": 1.0,
    "kp_plan_adherence": 1.0,
    "mean_kp_alignment": 0.86,
    "mean_distractor_quality": 0.78,
    "explanation_support_rate": 1.0,
    "mean_answer_relevancy": 0.82
  },
  "rows": [
    {
      "index": 0,
      "knowledge_point_id": 42,
      "question": "...",
      "rules": {
        "schema_valid": true,
        "answer_in_options": true,
        "single_correct": true,
        "kp_assigned": true,
        "kp_plan_match": true,
        "metadata_present": true,
        "bilingual_present": true
      },
      "rule_failures": [],
      "all_pass": true,
      "scores": {
        "kp_alignment": 0.9,
        "explanation_support": true,
        "distractor_quality": 0.8,
        "answer_relevancy": 0.85
      },
      "judge_reasons": {
        "kp_alignment": "Question tests the assigned reading skill.",
        "explanation_support": "Explanation matches the correct option.",
        "distractor_quality": "Distractors are plausible but wrong."
      }
    }
  ],
  "status": "ok"
}
```

### Layer A 规则（`rules`）

| 规则 | 含义 |
|------|------|
| `schema_valid` | MCQ 结构、4 选项、必填字段 |
| `answer_in_options` | 中英文标答均在对应选项中 |
| `single_correct` | 每种语言仅一个选项与标答匹配 |
| `kp_assigned` | 已绑定有效 `knowledge_point_id` |
| `kp_plan_match` | 与出题 plan 一致（有 plan 时） |
| `metadata_present` | 去重用 metadata 非空 |
| `bilingual_present` | 中英文 content/answer/explanation 齐全 |

`batch.rule_pass_rate` = 全部规则通过的题数 / 5。

### Layer B LLM Judge（`scores` + `judge_reasons`）

| 指标 | 含义 | 如何解读 |
|------|------|----------|
| `kp_alignment` | 题目是否在测分配的 KP | 低 → 题偏离知识点，改 prompt 或 KP 描述 |
| `explanation_support` | 解析是否支持标答 | `false` → 解析与答案不一致 |
| `distractor_quality` | 干扰项是否合理 | 低 → 干扰项太假或含多个正确项 |
| `answer_relevancy` | 答案是否切题 | 低 → 答案跑题，严重质量问题 |

批次均值：`mean_kp_alignment`、`mean_distractor_quality`、`explanation_support_rate`。

**组合解读：** `rule_pass_rate = 1` 但 `kp_alignment` 低 → 结构合法但 pedagogical 质量差。

### LLM 指标（Ragas Python）

| 指标 | 含义 | 来源 |
|------|------|------|
| `answer_relevancy` | 答案是否切题 | Python Ragas / LangWatch `response_relevancy` |

### 已移除（不适用于 diagnostic 出题）

以下指标假设有 RAG 文档检索，**不再默认运行**：

- `faithfulness` — KP 一行描述无法支撑答案，长期误报 0
- `context_precision` / `context_recall` — 无向量检索步骤

## 手动批量评测（可选）

```powershell
python evaluate_ragas.py --input buffer.jsonl --output ragas_result.json
```

## LangWatch（可选）

配置 `LANGWATCH_API_KEY` 后，trace 结构为：

```
diagnostic-generate（批次）
  ├── diagnostic-q1   → OUTPUT: { kp_alignment, explanation_support, distractor_quality, response_relevancy }
  ├── diagnostic-q2
  └── ...
```

每题 **一条** evaluation，OUTPUT 为纯分数 JSON（0–1），无 pass/fail 字段。
