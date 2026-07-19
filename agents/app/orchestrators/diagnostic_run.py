from __future__ import annotations

import uuid
from typing import Any

from app.agents.generator import generate_mcq_batch
from app.agents.planner import build_knowledge_point_ids_plan, plan_rationale
from app.models import DiagnosticRunRequest, DiagnosticRunResponse
from app.orchestrators.diagnostic import run_diagnostic_quality
from app.models import QualityRunRequest
from app.workers.dedupe import dedupe_questions, ensure_content_hash
from app.workers.persist import fetch_hashes_in_db, fetch_kp_usage_counts, persist_question


def run_diagnostic_run(request: DiagnosticRunRequest) -> DiagnosticRunResponse:
    run_id = str(uuid.uuid4())
    kp_list = [kp.model_dump() for kp in request.kp_list]
    num = max(1, min(20, request.num_questions))

    kp_ids = [int(kp["id"]) for kp in kp_list if kp.get("id") is not None]
    usage_counts: dict[int, int] = {}
    if request.use_db_planner and request.student_user_ids and request.grade_id and request.subject_id:
        try:
            usage_counts = fetch_kp_usage_counts(
                request.student_user_ids, request.grade_id, request.subject_id, kp_ids
            )
        except Exception:
            usage_counts = {}

    plan = build_knowledge_point_ids_plan(kp_list, num, kp_usage_counts=usage_counts or None)
    rationale = plan_rationale(plan, kp_list)

    ask_n = num + 5
    gen_plan = build_knowledge_point_ids_plan(kp_list, ask_n, kp_usage_counts=usage_counts or None)
    gen_result = generate_mcq_batch(
        lang=request.lang,
        num_questions=ask_n,
        student_profile=request.student_profile,
        knowledge_points=kp_list,
        knowledge_point_ids_plan=gen_plan,
        grade_guidance=request.grade_guidance,
        retrieval_snippets=request.retrieval_snippets,
        avoid_metadata=request.avoid_metadata,
        feedback_context=request.feedback_context,
    )

    raw_questions = [ensure_content_hash(q) for q in gen_result.get("questions", [])]
    hashes = [q["content_options_hash"] for q in raw_questions if q.get("content_options_hash")]
    db_hashes: set[str] = set()
    if request.check_db_hashes and hashes:
        try:
            db_hashes = fetch_hashes_in_db(hashes)
        except Exception:
            db_hashes = set()

    deduped = dedupe_questions(raw_questions, db_hashes=db_hashes)
    questions = deduped["accepted"][:num]
    if len(questions) < num:
        questions = raw_questions[:num]

    quality = run_diagnostic_quality(
        QualityRunRequest(
            questions=questions,
            kp_list=request.kp_list,
            lang=request.lang,
            knowledge_point_ids_plan=plan,
            grade_guidance=request.grade_guidance,
            meta=request.meta,
            max_refine_rounds=request.max_refine_rounds,
            enable_refine=request.enable_refine,
        )
    )

    final_questions = quality.questions or questions
    persisted_ids: list[int | None] = []
    if request.persist and request.grade_id and request.subject_id:
        for q in final_questions:
            try:
                q2 = ensure_content_hash(dict(q))
                pid = persist_question(q2, grade_id=request.grade_id, subject_id=request.subject_id)
                persisted_ids.append(pid)
                if pid is not None:
                    q2["id"] = pid
            except Exception:
                persisted_ids.append(None)

    lesson = gen_result.get("lesson") or {}
    return DiagnosticRunResponse(
        run_id=run_id,
        status="ok" if final_questions else "empty",
        knowledge_point_ids_plan=plan,
        plan_rationale=rationale,
        lesson=lesson,
        questions=final_questions,
        quality_batch_id=quality.batch_id,
        quality_batch=quality.batch,
        quality_rows=quality.rows,
        refine_rounds=quality.refine_rounds,
        dedupe_rejected=len(deduped.get("rejected", [])),
        persisted_ids=persisted_ids if request.persist else [],
    )
