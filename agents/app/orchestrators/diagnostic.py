from __future__ import annotations

import uuid
from typing import Any, Literal, TypedDict

from langgraph.graph import END, StateGraph

from app.agents.critic import needs_refine, run_critic
from app.agents.refiner import refine_questions
from app.evaluators.quality import evaluate_batch
from app.models import QualityRunRequest, QualityRunResponse


class DiagnosticState(TypedDict, total=False):
    batch_id: str
    questions: list[dict[str, Any]]
    kp_list: list[dict[str, Any]]
    lang: str
    knowledge_point_ids_plan: list[int] | None
    grade_guidance: str
    meta: dict[str, Any]
    max_refine_rounds: int
    enable_refine: bool
    refine_round: int
    rows: list[dict[str, Any]]
    batch: dict[str, Any]
    critiques: list[dict[str, Any]]
    status: str


def _evaluate_node(state: DiagnosticState) -> DiagnosticState:
    kp_list = [kp if isinstance(kp, dict) else kp.model_dump() for kp in state.get("kp_list", [])]
    result = evaluate_batch(
        state["questions"],
        kp_list,
        lang=state.get("lang", "en"),
        knowledge_point_ids_plan=state.get("knowledge_point_ids_plan"),
        grade_guidance=state.get("grade_guidance", ""),
    )
    return {**state, "rows": result["rows"], "batch": result["batch"], "status": "evaluated"}


def _critic_node(state: DiagnosticState) -> DiagnosticState:
    critiques = run_critic(state.get("rows", []))
    rows = [dict(row) for row in state.get("rows", [])]
    for critique in critiques:
        idx = critique["index"]
        if 0 <= idx < len(rows):
            rows[idx]["critique"] = critique
    return {**state, "rows": rows, "critiques": critiques, "status": "critiqued"}


def _refine_node(state: DiagnosticState) -> DiagnosticState:
    kp_list = [kp if isinstance(kp, dict) else kp.model_dump() for kp in state.get("kp_list", [])]
    critiques = [row["critique"] for row in state.get("rows", []) if row.get("critique")]
    questions = refine_questions(
        state["questions"],
        critiques,
        kp_list,
        state.get("lang", "en"),
        state.get("grade_guidance", ""),
    )
    return {
        **state,
        "questions": questions,
        "refine_round": state.get("refine_round", 0) + 1,
        "status": "refined",
    }


def _route_after_critic(state: DiagnosticState) -> Literal["refine", "done"]:
    if not state.get("enable_refine", True):
        return "done"
    if state.get("refine_round", 0) >= state.get("max_refine_rounds", 2):
        return "done"
    if any(needs_refine(row) for row in state.get("rows", [])):
        return "refine"
    return "done"


def build_diagnostic_graph():
    graph = StateGraph(DiagnosticState)
    graph.add_node("evaluate", _evaluate_node)
    graph.add_node("critic", _critic_node)
    graph.add_node("refine", _refine_node)
    graph.set_entry_point("evaluate")
    graph.add_edge("evaluate", "critic")
    graph.add_conditional_edges("critic", _route_after_critic, {"refine": "refine", "done": END})
    graph.add_edge("refine", "evaluate")
    return graph.compile()


_GRAPH = None


def get_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_diagnostic_graph()
    return _GRAPH


def run_diagnostic_quality(request: QualityRunRequest) -> QualityRunResponse:
    batch_id = str(uuid.uuid4())
    kp_list = [kp.model_dump() for kp in request.kp_list]
    initial: DiagnosticState = {
        "batch_id": batch_id,
        "questions": [dict(q) for q in request.questions],
        "kp_list": kp_list,
        "lang": request.lang,
        "knowledge_point_ids_plan": request.knowledge_point_ids_plan,
        "grade_guidance": request.grade_guidance,
        "meta": request.meta,
        "max_refine_rounds": request.max_refine_rounds,
        "enable_refine": request.enable_refine,
        "refine_round": 0,
        "status": "started",
    }
    final = get_graph().invoke(initial)
    status = "ok" if final.get("rows") else "empty"
    return QualityRunResponse(
        batch_id=batch_id,
        status=status,
        batch=final.get("batch") or {},
        rows=final.get("rows") or [],
        questions=final.get("questions") or request.questions,
        refine_rounds=final.get("refine_round", 0),
    )
