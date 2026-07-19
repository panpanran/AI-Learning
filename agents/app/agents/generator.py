from __future__ import annotations

import json
import os
from typing import Any

from openai import OpenAI

from app.config import OPENAI_API_KEY, OPENAI_MODEL
from app.prompts.diagnostic import build_user_prompt, get_system_prompt
from app.samples import extract_bilingual_options


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


def _pick_bilingual_field(obj: Any, en_key: str, zh_key: str, nested_key: str | None = None) -> tuple[str, str]:
    if isinstance(obj, dict):
        if nested_key and isinstance(obj.get(nested_key), dict):
            nested = obj[nested_key]
            return str(nested.get("en") or nested.get("zh") or ""), str(nested.get("zh") or nested.get("en") or "")
        en = obj.get(en_key) or obj.get("en") or ""
        zh = obj.get(zh_key) or obj.get("zh") or ""
        return str(en), str(zh)
    return "", ""


def _coerce_question_shape(q: dict[str, Any]) -> dict[str, Any]:
    """Map common LLM JSON variants to canonical diagnostic question fields."""
    out = dict(q)
    if not out.get("content_en") and not out.get("content_cn"):
        if isinstance(out.get("question"), dict):
            out["content_en"], out["content_cn"] = _pick_bilingual_field(out, "content_en", "content_cn", "question")
        elif isinstance(out.get("prompt"), dict):
            out["content_en"], out["content_cn"] = _pick_bilingual_field(out, "content_en", "content_cn", "prompt")

    if not out.get("answer_en") and not out.get("answer_cn"):
        if isinstance(out.get("correctAnswer"), dict):
            out["answer_en"], out["answer_cn"] = _pick_bilingual_field(out, "answer_en", "answer_cn", "correctAnswer")
        elif isinstance(out.get("answer"), dict):
            out["answer_en"], out["answer_cn"] = _pick_bilingual_field(out, "answer_en", "answer_cn", "answer")

    if not out.get("explanation_en") and not out.get("explanation_cn"):
        if isinstance(out.get("explanation"), dict):
            out["explanation_en"], out["explanation_cn"] = _pick_bilingual_field(
                out, "explanation_en", "explanation_cn", "explanation"
            )
    return out


def _normalize_question(
    q: dict[str, Any],
    index: int,
    plan: list[int],
    allowed_ids: set[int],
    fallback_kp_id: int | None,
) -> dict[str, Any] | None:
    q = _coerce_question_shape(q if isinstance(q, dict) else {})
    if not q or not (q.get("content_en") or q.get("content_cn")):
        return None
    bilingual = extract_bilingual_options(q.get("options"))
    if not bilingual or len(bilingual["zh"]) != 4 or len(bilingual["en"]) != 4:
        return None
    answer_en = str(q.get("answer_en") or "").strip()
    answer_cn = str(q.get("answer_cn") or "").strip()
    if answer_en not in bilingual["en"] or answer_cn not in bilingual["zh"]:
        return None

    planned = plan[index] if index < len(plan) else None
    if isinstance(planned, int) and (not allowed_ids or planned in allowed_ids):
        kp_id = planned
    else:
        raw = q.get("knowledge_point_id")
        kp_id = int(raw) if raw is not None and str(raw).strip().isdigit() else fallback_kp_id
        if kp_id is not None and allowed_ids and kp_id not in allowed_ids:
            kp_id = fallback_kp_id

    return {
        "type": "mcq",
        "content_cn": q.get("content_cn") or "",
        "content_en": q.get("content_en") or "",
        "options": {"zh": bilingual["zh"], "en": bilingual["en"]},
        "answer_cn": answer_cn,
        "answer_en": answer_en,
        "explanation_cn": q.get("explanation_cn") or "",
        "explanation_en": q.get("explanation_en") or "",
        "knowledge_point_id": kp_id,
        "metadata": q.get("metadata") if isinstance(q.get("metadata"), dict) else {},
    }


def generate_mcq_batch(
    *,
    lang: str,
    num_questions: int,
    student_profile: dict[str, Any],
    knowledge_points: list[dict[str, Any]],
    knowledge_point_ids_plan: list[int],
    grade_guidance: str = "",
    retrieval_snippets: list[Any] | None = None,
    avoid_metadata: list[Any] | None = None,
    feedback_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not OPENAI_API_KEY:
        raise RuntimeError("OpenAI not configured")

    allowed_ids = {int(kp["id"]) for kp in knowledge_points if kp.get("id") is not None}
    fallback_kp_id = int(knowledge_points[0]["id"]) if knowledge_points else None

    user_msg = build_user_prompt(
        lang,
        student_profile=json.dumps(student_profile, ensure_ascii=False),
        num_questions=num_questions,
        grade_guidance=grade_guidance,
        knowledge_points=json.dumps(knowledge_points, ensure_ascii=False),
        knowledge_point_ids_plan=json.dumps(knowledge_point_ids_plan),
        retrieval_snippets=json.dumps(retrieval_snippets or [], ensure_ascii=False),
        avoid_metadata=json.dumps(avoid_metadata or [], ensure_ascii=False),
        feedback_context=json.dumps(feedback_context or {}, ensure_ascii=False),
    )

    client = OpenAI(api_key=OPENAI_API_KEY)
    model = os.getenv("OPENAI_MODEL", OPENAI_MODEL or "gpt-4.1-mini")
    messages = [
        {"role": "system", "content": get_system_prompt(lang)},
        {"role": "user", "content": user_msg},
    ]

    try:
        completion = client.chat.completions.create(
            model=model,
            temperature=0.2,
            messages=messages,
            response_format={"type": "json_object"},
            max_tokens=5000,
        )
    except Exception as exc:
        if "response_format" in str(exc).lower():
            completion = client.chat.completions.create(
                model=model, temperature=0.2, messages=messages, max_tokens=5000
            )
        else:
            raise

    content = completion.choices[0].message.content or ""
    parsed = _parse_json(content)
    if not parsed or not isinstance(parsed.get("questions"), list):
        raise RuntimeError("Generator returned invalid JSON")

    questions = []
    for idx, q in enumerate(parsed["questions"]):
        normalized = _normalize_question(q, idx, knowledge_point_ids_plan, allowed_ids, fallback_kp_id)
        if normalized:
            questions.append(normalized)

    lesson = parsed.get("lesson") if isinstance(parsed.get("lesson"), dict) else {}
    return {"lesson": lesson, "questions": questions}
