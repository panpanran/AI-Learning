// Prompt templates for various generation points (Chinese + English)
// Each template is concise, instructs strict JSON output, and includes an example schema.

const diagnostic = {
    system_en: `You are an assessment designer. Produce ONLY valid JSON. Use the minimal text needed. Output must be parseable.

Quality rules (do internally, do NOT output your work):
- For any math/facts (place value, arithmetic, regrouping), solve and then self-check.
- Ensure the chosen correctAnswer is actually correct, and appears in the options exactly once.
- Ensure distractor options are wrong but plausible.
- Do NOT include step-by-step working; only include a one-sentence explanation.

If a knowledge point involves shape recognition / geometry identification, do NOT rely on visual images. Do NOT ask the student to look at a picture. Instead, write the question using descriptive features (properties) in text only. Example: "A shape with four right angles and four equal sides is called what?"`,
    system_zh: `你是出题与诊断的教师，输出必须为严格的 JSON。尽量简短并可解析。

质量规则（请在内部完成计算与复核，但不要输出详细演算过程）：
- 涉及数学/事实（位值、口算、进位等）必须先算出正确答案，再自检一遍。
- 确保正确答案真的正确，且在选项中只出现一次。
- 干扰项必须错误但合理。
- 解析只写一句话，不要写详细步骤。

如果该知识点涉及图形识别/几何图形辨认，请不要通过视觉图片出题，不要让学生“看图”。请通过文字描述图形的特征/性质来出题。例如：“四个角都是直角，且四条边都相等的图形是什么？”`,
    user_en: `Generate a diagnostic test for this student. Inputs: {{student_profile}}.
Grade/difficulty guidance (MUST follow): {{grade_guidance}}

You MUST generate exactly {{num_questions}} questions (questions.length === {{num_questions}}). ALL questions must be objective multiple-choice (type: "mcq"), with exactly 4 options in each language (options.en.length === 4 AND options.zh.length === 4), and ONLY ONE correct answer. Use these retrieval_snippets for reference: {{retrieval_snippets}}.

IMPORTANT (feature extraction / metadata):
- For EACH question, include a "metadata" object used for deduplication and retrieval. Do NOT make it too generic.
- metadata MUST be stable and language-independent (i.e., do not change metadata based on whether the question is shown in English or Chinese). For this project, use a single canonical metadata style:
  - Keep enum fields as specified (e.g., math metadata.type values are the fixed English enums below).
    - All FREE-TEXT string fields (e.g., context/word/story nouns/units descriptions) MUST be in English. Do NOT put Chinese words inside metadata.
- For MATH questions, metadata MUST be exactly this shape:
    { "type": "division"|"multiplication"|"addition"|"subtraction"|"fraction"|"geometry"|"other", "nums": number[], "context": string|null }
        Example: {"type":"division","nums":[12,3],"context":"apples"}
- For NON-math questions, metadata can be any stable JSON object (fields may differ by subject).
- For vocabulary-style questions, prefer this stable shape (all free-text values in English):
        {"type":"vocabulary","word":"apple","context":"fruit"}
- Avoid generating questions that are similar to these frequent metadata patterns for this student: {{avoid_metadata}}.
- If the same story template repeats, vary the numbers; avoid repeatedly using the same type/nums/result.

Knowledge points are pre-seeded (do NOT invent new ones): {{knowledge_points}}.
You are also given a required knowledge point assignment plan for each question index: {{knowledge_point_ids_plan}}.
The plan is an array of integers with length {{num_questions}}. For question i (0-based), you MUST set knowledge_point_id === knowledge_point_ids_plan[i].

    Return strict JSON with keys: {"lesson": {"title","explanation","images":[]}, "questions": [{"id","type":"mcq","content_cn":"string","content_en":"string","options":{"zh":["string","string","string","string"],"en":["string","string","string","string"]},"answer_cn":"string","answer_en":"string","explanation_cn":"string","explanation_en":"string","knowledge_point_id":123,"metadata":{...}}] }. All content, options, answers, and explanations must be provided in both Chinese and English. Do not return any text except valid JSON.`,
    user_zh: `为学生生成诊断测试。输入：{{student_profile}}。
年级/难度要求（必须遵守）：{{grade_guidance}}

你必须严格生成{{num_questions}}道题（questions.length === {{num_questions}}）。所有题目都必须是4选1的客观选择题（type: "mcq"，每种语言的 options.en.length === 4 且 options.zh.length === 4），且每题只有一个正确答案。可参考片段：{{retrieval_snippets}}。

重要（特征抽取 / metadata）：
- 每一道题必须包含一个 metadata 对象，用于去重和检索；不要写得太宽泛。
- metadata 必须稳定、与语言无关（不要因为题目展示语言是中文/英文而改变 metadata）。本项目约定使用统一的 metadata 书写风格：
  - 枚举字段保持固定值（例如数学题 metadata.type 只能从下面给定的英文枚举里选）。
    - 所有“自由文本”字符串字段（例如 context、word、故事名词、单位描述等）必须使用英文，不要在 metadata 里出现中文。
- 数学题的 metadata 必须严格是这种形状：
    {"type":"division"|"multiplication"|"addition"|"subtraction"|"fraction"|"geometry"|"other","nums":number[],"context":string|null}
        例：{"type":"division","nums":[12,3],"context":"apples"}
- 非数学题的 metadata 可以是任意稳定的 JSON 对象（不同学科字段可以不一样）。
- 如果是“词汇/概念类”题目，建议使用这种稳定形状（自由文本全英文）：
        {"type":"vocabulary","word":"apple","context":"fruit"}
- 需要避开与该学生“高频出现的 metadata 模式”相似的题目：{{avoid_metadata}}。
- 如果题型/情境很相似，请主动换数字，避免总是同一个 type/nums/结果。

知识点是预先存入数据库的输入列表（不要自造新的知识点）：{{knowledge_points}}。
同时你会拿到一个“每道题对应知识点”的分配计划：{{knowledge_point_ids_plan}}。
该计划是长度为 {{num_questions}} 的整数数组；第 i 题（从 0 开始）必须满足 knowledge_point_id === knowledge_point_ids_plan[i]。

    返回严格 JSON，格式为 {"lesson": {"title","explanation","images":[]}, "questions": [{"id","type":"mcq","content_cn":"string","content_en":"string","options":{"zh":["string","string","string","string"],"en":["string","string","string","string"]},"answer_cn":"string","answer_en":"string","explanation_cn":"string","explanation_en":"string","knowledge_point_id":123,"metadata":{...}}] }。所有题干、选项、答案、解析都必须同时提供中英文。只能返回 JSON，不要有其它内容。`,
    schema: {
        lesson: { title: 'string', explanation: 'string', images: ['url'] },
        questions: [{ id: 'string', type: 'mcq|short', prompt: 'string', options: ['string'], answer: 'string', explanation: 'string', knowledge_point_id: 123 }]
    },
    settings: { model: 'gpt-4.1-mini', temperature: 0.2, max_tokens: 1500 }
};

const analysis = {
    system_en: `You are a patient teacher that explains student mistakes briefly. Output strict JSON {analysis: string}.`,
    system_zh: `你是耐心的教师，简短说明学生错误并给出纠正建议。输出严格 JSON {analysis: string}.`,
    settings: { model: 'gpt-4.1-mini', temperature: 0.2, max_tokens: 300 }
};

const five_q = {
    // For knowledge point micro-practice
    system_en: `Create 5 short practice items focused on a single knowledge point. Output strict JSON {questions: [...] }.`,
    system_zh: `为知识点生成 5 道练习题，输出严格 JSON {questions: [...] }。`,
    settings: { model: 'gpt-4.1-mini', temperature: 0.2, max_tokens: 600 }
};

const summary200 = {
    system_en: `Write a 200-character (approx) student learning summary in the student's language. Return JSON {summary: string}.`,
    system_zh: `用学生语言写一段 200 字左右的学习总结，返回 JSON {summary: string}.`,
    settings: { model: 'gpt-4.1-mini', temperature: 0.2, max_tokens: 250 }
};

module.exports = { diagnostic, analysis, five_q, summary200 };
