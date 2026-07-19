"""Diagnostic MCQ prompts (ported from backend/lib/prompts.js)."""

SYSTEM_EN = """You are an assessment designer. Produce ONLY valid JSON. Use the minimal text needed. Output must be parseable.

Quality rules (do internally, do NOT output your work):
- For any math/facts (place value, arithmetic, regrouping), solve and then self-check.
- Ensure the chosen correctAnswer is actually correct, and appears in the options exactly once.
- Ensure distractor options are wrong but plausible.
- Do NOT include step-by-step working; only include a one-sentence explanation.

If a knowledge point involves shape recognition / geometry identification, do NOT rely on visual images. Do NOT ask the student to look at a picture. Instead, write the question using descriptive features (properties) in text only."""

SYSTEM_ZH = """你是出题与诊断的教师，输出必须为严格的 JSON。尽量简短并可解析。

质量规则（请在内部完成计算与复核，但不要输出详细演算过程）：
- 涉及数学/事实（位值、口算、进位等）必须先算出正确答案，再自检一遍。
- 确保正确答案真的正确，且在选项中只出现一次。
- 干扰项必须错误但合理。
- 解析只写一句话，不要写详细步骤。

如果该知识点涉及图形识别/几何图形辨认，请不要通过视觉图片出题，不要让学生“看图”。请通过文字描述图形的特征/性质来出题。"""

USER_EN = """Generate a diagnostic test for this student. Inputs: {student_profile}.
Grade/difficulty guidance (MUST follow): {grade_guidance}

You MUST generate exactly {num_questions} questions (questions.length === {num_questions}). ALL questions must be objective multiple-choice (type: "mcq"), with exactly 4 options in each language (options.en.length === 4 AND options.zh.length === 4), and ONLY ONE correct answer. Use these retrieval_snippets for reference: {retrieval_snippets}.

IMPORTANT (feature extraction / metadata):
- For EACH question, include a "metadata" object used for deduplication and retrieval.
- metadata MUST be stable and language-independent; free-text fields in English only.
- For MATH: {{"type":"division"|"multiplication"|"addition"|"subtraction"|"fraction"|"geometry"|"other","nums":number[],"context":string|null}}
- For vocabulary: {{"type":"vocabulary","word":"...","context":"..."}}
- Avoid similar patterns: {avoid_metadata}

Past diagnostic quality feedback (learn from this; do NOT copy questions verbatim): {feedback_context}
- few_shot_good: high-scoring example questions for similar knowledge points
- avoid_patterns: known failure patterns to avoid
- prompt_patches: extra authoring rules from prior reviews — treat these as hard constraints

Knowledge points (do NOT invent new ones): {knowledge_points}.
Required knowledge_point_ids_plan (length {num_questions}): {knowledge_point_ids_plan}. For question i, set knowledge_point_id === plan[i].

Return strict JSON: {{"lesson": {{"title","explanation","images":[]}}, "questions": [...]}}."""

USER_ZH = """为学生生成诊断测试。输入：{student_profile}。
年级/难度要求（必须遵守）：{grade_guidance}

你必须严格生成{num_questions}道题。所有题目都是4选1客观选择题（type: "mcq"）。可参考片段：{retrieval_snippets}。

重要：每题包含稳定的 metadata（自由文本用英文）。避开高频 metadata：{avoid_metadata}。
历史质量反馈（用于改进出题；不要照抄原题）：{feedback_context}
- few_shot_good：同知识点的高分例题
- avoid_patterns：已知失败模式，需避免
- prompt_patches：来自历史评审的额外出题规则，视为硬性约束
知识点列表：{knowledge_points}
分配计划 knowledge_point_ids_plan：{knowledge_point_ids_plan}

返回严格 JSON：{{"lesson": {{"title","explanation","images":[]}}, "questions": [...]}}。"""


def apply_template(template: str, values: dict[str, str]) -> str:
    out = template
    for key, val in values.items():
        out = out.replace("{" + key + "}", val)
    return out


def build_user_prompt(
    lang: str,
    *,
    student_profile: str,
    num_questions: int,
    grade_guidance: str,
    knowledge_points: str,
    knowledge_point_ids_plan: str,
    retrieval_snippets: str = "[]",
    avoid_metadata: str = "[]",
    feedback_context: str = "{}",
) -> str:
    tpl = USER_ZH if lang == "zh" else USER_EN
    return apply_template(tpl, {
        "student_profile": student_profile,
        "num_questions": str(num_questions),
        "grade_guidance": grade_guidance,
        "retrieval_snippets": retrieval_snippets,
        "avoid_metadata": avoid_metadata,
        "feedback_context": feedback_context,
        "knowledge_points": knowledge_points,
        "knowledge_point_ids_plan": knowledge_point_ids_plan,
    })


def get_system_prompt(lang: str) -> str:
    return SYSTEM_ZH if lang == "zh" else SYSTEM_EN
