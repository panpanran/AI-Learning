from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class KnowledgePoint(BaseModel):
    id: int
    name_cn: str = ""
    name_en: str = ""
    unit_name_cn: str = ""
    unit_name_en: str = ""
    description: str = ""


class QualityRunRequest(BaseModel):
    questions: list[dict[str, Any]]
    kp_list: list[KnowledgePoint] = Field(default_factory=list)
    lang: str = "en"
    knowledge_point_ids_plan: list[int] | None = None
    grade_guidance: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)
    max_refine_rounds: int = 2
    enable_refine: bool = True


class QualityRunResponse(BaseModel):
    batch_id: str
    schema_version: int = 2
    status: str
    batch: dict[str, Any]
    rows: list[dict[str, Any]]
    questions: list[dict[str, Any]]
    refine_rounds: int = 0


class DiagnosticRunRequest(BaseModel):
    num_questions: int = 5
    kp_list: list[KnowledgePoint] = Field(default_factory=list)
    lang: str = "en"
    student_profile: dict[str, Any] = Field(default_factory=dict)
    student_user_ids: list[int] = Field(default_factory=list)
    grade_id: int | None = None
    subject_id: int | None = None
    grade_guidance: str = ""
    retrieval_snippets: list[Any] = Field(default_factory=list)
    avoid_metadata: list[Any] = Field(default_factory=list)
    feedback_context: dict[str, Any] = Field(default_factory=dict)
    meta: dict[str, Any] = Field(default_factory=dict)
    use_db_planner: bool = True
    check_db_hashes: bool = True
    persist: bool = False
    max_refine_rounds: int = 2
    enable_refine: bool = True


class DiagnosticRunResponse(BaseModel):
    run_id: str
    status: str
    knowledge_point_ids_plan: list[int] = Field(default_factory=list)
    plan_rationale: str = ""
    lesson: dict[str, Any] = Field(default_factory=dict)
    questions: list[dict[str, Any]] = Field(default_factory=list)
    quality_batch_id: str = ""
    quality_batch: dict[str, Any] = Field(default_factory=dict)
    quality_rows: list[dict[str, Any]] = Field(default_factory=list)
    refine_rounds: int = 0
    dedupe_rejected: int = 0
    persisted_ids: list[int | None] = Field(default_factory=list)


class FeedbackTriageItemIn(BaseModel):
    feedback_id: int | None = None
    question_id: int | None = None
    category: str = "other"
    comment: str = ""
    given_answer: str | None = None
    question: dict[str, Any] = Field(default_factory=dict)


class FeedbackTriageItemResult(BaseModel):
    feedback_id: int | None = None
    question_id: int | None = None
    status: str
    category: str = "other"
    proposed_fix: dict[str, Any] | None = None
    decision: str = ""
    apply: bool = False


class FeedbackTriageRequest(BaseModel):
    items: list[FeedbackTriageItemIn] = Field(default_factory=list)
    feedback_id: int | None = None
    feedback_ids: list[int] = Field(default_factory=list)
    auto_apply: bool = True
    min_confidence: float = 0.75
    skip_llm: bool = False
    meta: dict[str, Any] = Field(default_factory=dict)
    mode: str = "workflow"


class FeedbackTriageResponse(BaseModel):
    batch_id: str = ""
    status: str = "ok"
    message: str = ""
    items: list[FeedbackTriageItemResult] = Field(default_factory=list)
    feedback_ids: list[int] = Field(default_factory=list)
