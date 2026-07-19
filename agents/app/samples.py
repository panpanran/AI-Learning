from __future__ import annotations

from typing import Any


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def extract_bilingual_options(options: Any) -> dict[str, list[str]] | None:
    if not options:
        return None
    if isinstance(options, dict):
        zh = options.get("zh")
        en = options.get("en")
        if isinstance(zh, list) and isinstance(en, list) and zh and en:
            return {"zh": [normalize_text(x) for x in zh], "en": [normalize_text(x) for x in en]}
        if isinstance(en, list) and en and not zh:
            return {"zh": [normalize_text(x) for x in en], "en": [normalize_text(x) for x in en]}
        if isinstance(zh, list) and zh and not en:
            return {"zh": [normalize_text(x) for x in zh], "en": [normalize_text(x) for x in zh]}
        keys = ["A", "B", "C", "D"]
        zh2, en2 = [], []
        for key in keys:
            item = options.get(key)
            if not isinstance(item, dict):
                return None
            z, e = normalize_text(item.get("zh")), normalize_text(item.get("en"))
            if not z or not e:
                return None
            zh2.append(z)
            en2.append(e)
        return {"zh": zh2, "en": en2}
    if isinstance(options, list):
        arr = [normalize_text(x) for x in options]
        return {"zh": arr, "en": arr}
    return None


def build_eval_samples(
    questions: list[dict[str, Any]],
    kp_list: list[dict[str, Any]],
    lang: str,
    grade_guidance: str = "",
) -> list[dict[str, Any]]:
    kp_by_id = {int(kp["id"]): kp for kp in kp_list if kp.get("id") is not None}

    samples = []
    for q in questions:
        kp_id = int(q["knowledge_point_id"]) if q.get("knowledge_point_id") is not None else None
        kp = kp_by_id.get(kp_id) if kp_id is not None else None
        bilingual = extract_bilingual_options(q.get("options"))

        question = q.get("content_cn") or q.get("content_en") or "" if lang == "zh" else q.get("content_en") or q.get("content_cn") or ""
        answer = q.get("answer_cn") or q.get("answer_en") or "" if lang == "zh" else q.get("answer_en") or q.get("answer_cn") or ""
        explanation = (
            (q.get("explanation_cn") or q.get("explanation_en") or answer)
            if lang == "zh"
            else (q.get("explanation_en") or q.get("explanation_cn") or answer)
        )

        if kp:
            kp_text = (
                f"{kp.get('name_cn', '')}: {kp.get('description', '')}".strip(": ")
                if lang == "zh"
                else f"{kp.get('name_en', '')}: {kp.get('description', '')}".strip(": ")
            )
            eval_context = {
                "kp_id": kp_id,
                "kp_name": kp.get("name_cn") if lang == "zh" else kp.get("name_en"),
                "unit_name": kp.get("unit_name_cn") if lang == "zh" else kp.get("unit_name_en"),
                "description": kp.get("description", ""),
                "grade_guidance": grade_guidance,
            }
        else:
            kp_text = None
            eval_context = None

        opt_lang = "zh" if lang == "zh" else "en"
        samples.append(
            {
                "question": question,
                "answer": answer,
                "explanation": explanation,
                "ground_truth": explanation,
                "contexts": [kp_text] if kp_text else ["(no knowledge-point context)"],
                "options": bilingual[opt_lang] if bilingual else [],
                "options_zh": bilingual["zh"] if bilingual else [],
                "options_en": bilingual["en"] if bilingual else [],
                "eval_context": eval_context,
                "knowledge_point_id": kp_id,
            }
        )
    return samples
