from __future__ import annotations

import json
import os
from typing import Any

from openai import OpenAI

from app.config import DIAG_EVAL_MODEL, OPENAI_API_KEY
from app.samples import build_eval_samples


def _parse_json(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                return None
    return None


def refine_question(
    question: dict[str, Any],
    critique: dict[str, Any],
    kp_list: list[dict[str, Any]],
    lang: str,
    grade_guidance: str = "",
) -> dict[str, Any]:
    if not OPENAI_API_KEY:
        raise RuntimeError("OpenAI not configured")

    sample = build_eval_samples([question], kp_list, lang, grade_guidance)[0]
    ctx = sample.get("eval_context") or {}
    client = OpenAI(api_key=OPENAI_API_KEY)
    model = DIAG_EVAL_MODEL or os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    prompt = f"""Rewrite this diagnostic MCQ to fix the quality issues.
Keep the same knowledge_point_id ({question.get('knowledge_point_id')}).
Return strict JSON with one question object using the same schema as input.

Knowledge point: {json.dumps(ctx, ensure_ascii=False)}
Critique: {json.dumps(critique, ensure_ascii=False)}
Current question JSON: {json.dumps(question, ensure_ascii=False)}

Required fields: type, content_cn, content_en, options (zh/en arrays of 4), answer_cn, answer_en, explanation_cn, explanation_en, knowledge_point_id, metadata.
"""

    completion = client.chat.completions.create(
        model=model,
        temperature=0,
        messages=[
            {"role": "system", "content": "You improve educational MCQs. Output valid JSON only."},
            {"role": "user", "content": prompt},
        ],
        response_format={"type": "json_object"},
    )
    content = completion.choices[0].message.content or ""
    parsed = _parse_json(content)
    if not parsed:
        raise RuntimeError("Refiner returned invalid JSON")
    if "question" in parsed and isinstance(parsed["question"], dict):
        return parsed["question"]
    if parsed.get("type") == "mcq":
        return parsed
    if isinstance(parsed.get("questions"), list) and parsed["questions"]:
        return parsed["questions"][0]
    raise RuntimeError("Refiner JSON missing question")


def refine_questions(
    questions: list[dict[str, Any]],
    critiques: list[dict[str, Any]],
    kp_list: list[dict[str, Any]],
    lang: str,
    grade_guidance: str = "",
) -> list[dict[str, Any]]:
    critique_by_index = {c["index"]: c for c in critiques}
    updated = list(questions)
    for index, critique in critique_by_index.items():
        if index < 0 or index >= len(updated):
            continue
        try:
            updated[index] = refine_question(updated[index], critique, kp_list, lang, grade_guidance)
        except Exception:
            continue
    return updated
