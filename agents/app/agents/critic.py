from __future__ import annotations

from typing import Any

from app.config import THRESHOLDS


def build_critique(row: dict[str, Any]) -> dict[str, Any] | None:
    scores = row.get("scores") or {}
    reasons = row.get("judge_reasons") or {}
    issues: list[str] = []
    instructions: list[str] = []

    kp = scores.get("kp_alignment")
    if isinstance(kp, (int, float)) and kp < THRESHOLDS["negative_kp_alignment"]:
        issues.append("kp_alignment_low")
        if reasons.get("kp_alignment"):
            instructions.append(reasons["kp_alignment"])

    dist = scores.get("distractor_quality")
    if isinstance(dist, (int, float)) and dist < THRESHOLDS["negative_distractor_quality"]:
        issues.append("distractor_quality_low")
        if reasons.get("distractor_quality"):
            instructions.append(reasons["distractor_quality"])

    rel = scores.get("response_relevancy", scores.get("answer_relevancy"))
    if isinstance(rel, (int, float)) and rel < THRESHOLDS["negative_response_relevancy"]:
        issues.append("response_relevancy_low")

    if row.get("all_pass") is False and row.get("rule_failures"):
        issues.append("rule_failure")
        instructions.append(f"Fix rule failures: {', '.join(row['rule_failures'])}")

    if not issues:
        return None

    return {
        "issues": issues,
        "instruction": " ".join(instructions).strip(),
        "severity": "high" if "rule_failure" in issues else "medium",
        "target_kp_id": row.get("knowledge_point_id"),
    }


def needs_refine(row: dict[str, Any]) -> bool:
    if row.get("all_pass") is False:
        return True
    critique = build_critique(row)
    return critique is not None and bool(critique.get("issues"))


def run_critic(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    critiques = []
    for row in rows:
        critique = build_critique(row)
        if critique:
            critiques.append({"index": row["index"], **critique})
    return critiques
