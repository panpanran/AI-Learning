from __future__ import annotations

from typing import Any

from app.evaluators.judge import run_diagnostic_judge
from app.evaluators.rules import run_diagnostic_rules
from app.samples import build_eval_samples


def merge_rows(rule_rows: list[dict[str, Any]], judge_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged = []
    for index, rule_row in enumerate(rule_rows):
        judge_row = judge_rows[index] if index < len(judge_rows) else {}
        scores = {}
        if judge_row.get("scores"):
            scores.update(judge_row["scores"])
        row = {**rule_row}
        if scores:
            row["scores"] = scores
        if judge_row.get("judge_reasons"):
            row["judge_reasons"] = judge_row["judge_reasons"]
        if judge_row.get("error"):
            row["judge_error"] = judge_row["error"]
        merged.append(row)
    return merged


def evaluate_batch(
    questions: list[dict[str, Any]],
    kp_list: list[dict[str, Any]],
    *,
    lang: str = "en",
    knowledge_point_ids_plan: list[int] | None = None,
    grade_guidance: str = "",
) -> dict[str, Any]:
    rule_result = run_diagnostic_rules(
        questions,
        kp_list,
        lang=lang,
        knowledge_point_ids_plan=knowledge_point_ids_plan,
    )
    samples = build_eval_samples(questions, kp_list, lang, grade_guidance)
    judge_result = run_diagnostic_judge(samples)
    rows = merge_rows(rule_result["rows"], judge_result["rows"])
    batch = {**rule_result["batch"], **judge_result["batch"]}
    return {"rows": rows, "batch": batch, "samples": samples}
