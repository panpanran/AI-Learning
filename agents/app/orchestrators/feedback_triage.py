"""LangGraph workflow: batch parent-feedback triage (propose → gate).

Human pause is durable via DB status `acknowledged` + Express `/feedback` UI
(not an in-process LangGraph interrupt).
"""

from __future__ import annotations

import uuid
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from app.agents.feedback_proposer import (
    can_auto_apply_llm,
    can_auto_apply_math,
    find_matching_option,
    has_cae_change,
    propose_for_item,
)
from app.models import FeedbackTriageRequest, FeedbackTriageResponse, FeedbackTriageItemResult


class FeedbackTriageState(TypedDict, total=False):
    batch_id: str
    items: list[dict[str, Any]]
    auto_apply: bool
    min_confidence: float
    skip_llm: bool
    meta: dict[str, Any]
    proposed: list[dict[str, Any]]
    results: list[dict[str, Any]]
    status: str


DISMISS_CATEGORIES = {"not_a_bug", "too_hard", "too_easy"}


def _propose_node(state: FeedbackTriageState) -> FeedbackTriageState:
    proposed: list[dict[str, Any]] = []
    for item in state.get("items") or []:
        proposed.append(
            propose_for_item(
                item,
                skip_llm=bool(state.get("skip_llm")),
            )
        )
    return {**state, "proposed": proposed, "status": "proposed"}


def _snap_answers_to_options(question: dict[str, Any], proposed: dict[str, Any]) -> dict[str, Any]:
    out = dict(proposed)
    options = question.get("options")
    if out.get("answer_cn"):
        z = find_matching_option(
            {"zh": options.get("zh")} if isinstance(options, dict) else options,
            out["answer_cn"],
        ) or find_matching_option(options, out["answer_cn"])
        if z:
            out["answer_cn"] = z
    if out.get("answer_en"):
        e = find_matching_option(
            {"en": options.get("en")} if isinstance(options, dict) else options,
            out["answer_en"],
        ) or find_matching_option(options, out["answer_en"])
        if e:
            out["answer_en"] = e
    return out


def _gate_one(
    row: dict[str, Any],
    *,
    auto_apply: bool,
    min_confidence: float,
    batch_id: str,
) -> dict[str, Any]:
    feedback_id = row.get("feedback_id")
    question = dict(row.get("question") or {})
    question_id = row.get("question_id") or question.get("id")
    category = str(row.get("category") or "other")
    dismiss = bool(row.get("dismiss"))
    proposed = row.get("proposed_fix") if isinstance(row.get("proposed_fix"), dict) else None

    if dismiss or category in DISMISS_CATEGORIES:
        pf = proposed or {"reason": "dismiss", "dismiss": True}
        pf = {**pf, "batch_id": batch_id, "workflow": "agents_feedback_triage"}
        return {
            "feedback_id": feedback_id,
            "question_id": question_id,
            "status": "dismissed",
            "category": category,
            "proposed_fix": pf,
            "decision": "dismiss",
            "apply": False,
        }

    if proposed:
        proposed = {**proposed, "batch_id": batch_id, "workflow": "agents_feedback_triage"}

    llm_conf = None
    if proposed and proposed.get("confidence") is not None:
        try:
            llm_conf = float(proposed["confidence"])
        except (TypeError, ValueError):
            llm_conf = None

    math_ok = can_auto_apply_math(question, proposed)
    llm_ok = can_auto_apply_llm(question, proposed, llm_conf, min_confidence)
    should_apply = bool(
        auto_apply
        and proposed
        and has_cae_change(proposed)
        and (math_ok or llm_ok)
    )

    if should_apply:
        proposed = _snap_answers_to_options(question, proposed)
        proposed["auto_applicable"] = True
        proposed["apply_via"] = "math_or_llm" if math_ok else "llm"
        proposed["confidence"] = llm_conf
        return {
            "feedback_id": feedback_id,
            "question_id": question_id,
            "status": "applied",
            "category": category,
            "proposed_fix": proposed,
            "decision": "auto_apply",
            "apply": True,
        }

    pf = proposed or {"reason": "needs_human_review"}
    pf = {**pf, "batch_id": batch_id, "workflow": "agents_feedback_triage"}
    return {
        "feedback_id": feedback_id,
        "question_id": question_id,
        "status": "acknowledged",
        "category": category,
        "proposed_fix": pf,
        "decision": "await_human",
        "apply": False,
    }


def _gate_node(state: FeedbackTriageState) -> FeedbackTriageState:
    batch_id = state.get("batch_id") or str(uuid.uuid4())
    auto_apply = bool(state.get("auto_apply", True))
    min_confidence = float(state.get("min_confidence") or 0.75)
    results = [
        _gate_one(row, auto_apply=auto_apply, min_confidence=min_confidence, batch_id=batch_id)
        for row in (state.get("proposed") or [])
    ]
    awaiting = sum(1 for r in results if r.get("status") == "acknowledged")
    status = "ok"
    if not results:
        status = "empty"
    elif awaiting and awaiting == len(results):
        status = "awaiting_human"
    elif awaiting:
        status = "partial_awaiting_human"
    return {**state, "batch_id": batch_id, "results": results, "status": status}


def build_feedback_triage_graph():
    graph = StateGraph(FeedbackTriageState)
    graph.add_node("propose", _propose_node)
    graph.add_node("gate", _gate_node)
    graph.set_entry_point("propose")
    graph.add_edge("propose", "gate")
    graph.add_edge("gate", END)
    return graph.compile()


_GRAPH = None


def get_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_feedback_triage_graph()
    return _GRAPH


def run_feedback_triage(request: FeedbackTriageRequest) -> FeedbackTriageResponse:
    items = [item.model_dump() if hasattr(item, "model_dump") else dict(item) for item in (request.items or [])]
    # Support legacy stub fields
    if not items and request.feedback_id is not None:
        items = [{"feedback_id": request.feedback_id}]
    if not items and request.feedback_ids:
        items = [{"feedback_id": i} for i in request.feedback_ids]

    # Cap batch
    items = items[: max(1, min(20, len(items) or 1))] if items else []
    if not items:
        return FeedbackTriageResponse(
            batch_id=str(uuid.uuid4()),
            status="empty",
            message="No items to triage",
            items=[],
            feedback_ids=[],
        )

    batch_id = str(uuid.uuid4())
    initial: FeedbackTriageState = {
        "batch_id": batch_id,
        "items": items,
        "auto_apply": bool(request.auto_apply),
        "min_confidence": float(request.min_confidence),
        "skip_llm": bool(request.skip_llm),
        "meta": dict(request.meta or {}),
        "status": "started",
    }
    final = get_graph().invoke(initial)
    results = final.get("results") or []
    return FeedbackTriageResponse(
        batch_id=str(final.get("batch_id") or batch_id),
        status=str(final.get("status") or "ok"),
        message="agents feedback triage workflow",
        items=[FeedbackTriageItemResult(**r) for r in results],
        feedback_ids=[int(r["feedback_id"]) for r in results if r.get("feedback_id") is not None],
    )
