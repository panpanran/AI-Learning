from __future__ import annotations

from typing import Any

from app.samples import extract_bilingual_options, normalize_text


def _count_matches(options: list[str], answer: str) -> int:
    norm = normalize_text(answer)
    if not norm:
        return 0
    return sum(1 for opt in options if normalize_text(opt) == norm)


def _check_schema(q: dict[str, Any]) -> tuple[bool, list[str], dict[str, list[str]] | None]:
    failures: list[str] = []
    if normalize_text(q.get("type") or "mcq") != "mcq":
        failures.append("type must be mcq")
    bilingual = extract_bilingual_options(q.get("options"))
    if not bilingual:
        failures.append("options missing or invalid bilingual shape")
    else:
        if len(bilingual["zh"]) != 4:
            failures.append("options.zh must have 4 items")
        if len(bilingual["en"]) != 4:
            failures.append("options.en must have 4 items")
    for field in [
        "content_cn", "content_en", "answer_cn", "answer_en",
        "explanation_cn", "explanation_en",
    ]:
        if not normalize_text(q.get(field)):
            failures.append(f"{field} is required")
    return len(failures) == 0, failures, bilingual


def run_diagnostic_rules(
    questions: list[dict[str, Any]],
    kp_list: list[dict[str, Any]],
    *,
    lang: str = "en",
    knowledge_point_ids_plan: list[int] | None = None,
) -> dict[str, Any]:
    if not questions:
        return {"rows": [], "batch": {"rule_pass_rate": 0, "kp_coverage": 0, "kp_plan_adherence": None}}

    allowed = {int(kp["id"]) for kp in kp_list if kp.get("id") is not None}
    rows = []

    for index, q in enumerate(questions):
        failures: list[str] = []
        rules: dict[str, Any] = {}

        schema_ok, _, bilingual = _check_schema(q)
        rules["schema_valid"] = schema_ok
        if not schema_ok:
            failures.append("schema_valid")

        answer_cn = normalize_text(q.get("answer_cn"))
        answer_en = normalize_text(q.get("answer_en"))
        if not bilingual:
            bilingual = extract_bilingual_options(q.get("options"))

        rules["answer_in_options"] = bool(
            bilingual
            and answer_cn
            and answer_en
            and any(normalize_text(o) == answer_cn for o in bilingual["zh"])
            and any(normalize_text(o) == answer_en for o in bilingual["en"])
        )
        if not rules["answer_in_options"]:
            failures.append("answer_in_options")

        zh_matches = _count_matches(bilingual["zh"], answer_cn) if bilingual else 0
        en_matches = _count_matches(bilingual["en"], answer_en) if bilingual else 0
        rules["single_correct"] = zh_matches == 1 and en_matches == 1
        if not rules["single_correct"]:
            failures.append("single_correct")

        kp_id = int(q["knowledge_point_id"]) if q.get("knowledge_point_id") is not None else None
        rules["kp_assigned"] = kp_id is not None and (not allowed or kp_id in allowed)
        if not rules["kp_assigned"]:
            failures.append("kp_assigned")

        # kp_plan_match is informational only (feeds batch kp_plan_adherence).
        # It must NOT gate all_pass: questions selected from the DB, deduped,
        # refilled or refined never follow the audit-time plan by index, so a
        # strict slot comparison produces spurious negatives that poison the
        # feedback loop. Per-question KP correctness is covered by kp_assigned
        # plus the judge's kp_alignment score.
        if knowledge_point_ids_plan is not None and index < len(knowledge_point_ids_plan):
            planned = knowledge_point_ids_plan[index]
            rules["kp_plan_match"] = kp_id == planned
        else:
            rules["kp_plan_match"] = None

        metadata = q.get("metadata")
        rules["metadata_present"] = isinstance(metadata, dict) and bool(metadata) and not isinstance(metadata, list)
        if not rules["metadata_present"]:
            failures.append("metadata_present")

        rules["bilingual_present"] = bool(
            normalize_text(q.get("content_cn"))
            and normalize_text(q.get("content_en"))
            and answer_cn
            and answer_en
            and normalize_text(q.get("explanation_cn"))
            and normalize_text(q.get("explanation_en"))
            and bilingual
            and len(bilingual["zh"]) == 4
            and len(bilingual["en"]) == 4
        )
        if not rules["bilingual_present"]:
            failures.append("bilingual_present")

        applicable = [v for k, v in rules.items() if v is not None and k != "kp_plan_match"]
        all_pass = all(v is True for v in applicable)

        question_text = (
            (q.get("content_cn") or q.get("content_en") or "")
            if lang == "zh"
            else (q.get("content_en") or q.get("content_cn") or "")
        )
        rows.append(
            {
                "index": index,
                "knowledge_point_id": kp_id,
                "question": question_text,
                "rules": rules,
                "rule_failures": failures,
                "all_pass": all_pass,
            }
        )

    pass_count = sum(1 for row in rows if row["all_pass"])
    unique_kps = {row["knowledge_point_id"] for row in rows if row["knowledge_point_id"] is not None}
    kp_plan_adherence = None
    if knowledge_point_ids_plan is not None and len(knowledge_point_ids_plan) >= len(questions):
        kp_plan_adherence = sum(1 for row in rows if row["rules"].get("kp_plan_match") is True) / len(questions)

    return {
        "rows": rows,
        "batch": {
            "rule_pass_rate": pass_count / len(questions),
            "kp_coverage": len(unique_kps) / len(questions),
            "kp_plan_adherence": kp_plan_adherence,
        },
    }
