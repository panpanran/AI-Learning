from __future__ import annotations

import random
from typing import Any


def build_knowledge_point_ids_plan(
    knowledge_points: list[dict[str, Any]],
    desired_count: int,
    *,
    kp_usage_counts: dict[int, int] | None = None,
) -> list[int]:
    """Select knowledge_point_id for each question slot (Phase C planner)."""
    raw_ids = [
        int(kp["id"])
        for kp in knowledge_points
        if kp.get("id") is not None
    ]
    ids = list(dict.fromkeys(raw_ids))
    m = max(0, int(desired_count) or 0)
    if not ids or not m:
        return []

    counts = kp_usage_counts or {}
    ordered = sorted(ids, key=lambda kid: (counts.get(kid, 0), random.random()))

    if m <= len(ordered):
        return ordered[:m]

    plan = ordered[:]
    pool_size = min(len(ordered), max(3, (len(ordered) + 2) // 3))
    repeat_pool = ordered[:pool_size]
    while len(plan) < m:
        plan.append(random.choice(repeat_pool))
    return plan


def plan_rationale(plan: list[int], knowledge_points: list[dict[str, Any]]) -> str:
    kp_names = {int(kp["id"]): kp.get("name_en") or kp.get("name_cn") or str(kp["id"]) for kp in knowledge_points}
    parts = [f"slot {i}: KP {kid} ({kp_names.get(kid, '?')})" for i, kid in enumerate(plan)]
    return "; ".join(parts)
