from __future__ import annotations

from app.agents.feedback_proposer import (
    build_math_proposed_fix,
    can_auto_apply_llm,
    can_auto_apply_math,
    compute_math_result,
)
from app.models import FeedbackTriageItemIn, FeedbackTriageRequest
from app.orchestrators.feedback_triage import run_feedback_triage


def test_compute_math_multiplication():
    assert compute_math_result({"type": "multiplication", "nums": [12, 8]}) == "96"


def test_math_auto_apply_when_answer_in_options():
    question = {
        "options": {"zh": ["96", "88", "100", "80"], "en": ["96", "88", "100", "80"]},
        "answer_cn": "88",
        "answer_en": "88",
    }
    proposed = build_math_proposed_fix(question, "96")
    assert can_auto_apply_math(question, proposed)


def test_llm_gate_low_confidence_blocks():
    question = {
        "options": {"zh": ["A", "B"], "en": ["A", "B"]},
    }
    proposed = {
        "answer_cn": "A",
        "answer_en": "A",
        "confidence": 0.4,
        "source": "llm",
    }
    assert can_auto_apply_llm(question, proposed, 0.4, 0.75) is False


def test_batch_gate_await_human_without_llm():
    req = FeedbackTriageRequest(
        items=[
            FeedbackTriageItemIn(
                feedback_id=10,
                question_id=100,
                comment="答案好像不对",
                category="wrong_answer",
                question={
                    "id": 100,
                    "content_cn": "12×8=?",
                    "content_en": "12×8=?",
                    "answer_cn": "88",
                    "answer_en": "88",
                    "explanation_cn": "错",
                    "explanation_en": "wrong",
                    "options": {"zh": ["96", "88"], "en": ["96", "88"]},
                    "metadata": {"type": "multiplication", "nums": [12, 8]},
                },
            ),
            FeedbackTriageItemIn(
                feedback_id=11,
                question_id=101,
                comment="太难了",
                category="too_hard",
                question={
                    "id": 101,
                    "content_cn": "x",
                    "content_en": "x",
                    "answer_cn": "1",
                    "answer_en": "1",
                    "options": {"zh": ["1", "2"], "en": ["1", "2"]},
                    "metadata": {},
                },
            ),
        ],
        auto_apply=True,
        min_confidence=0.75,
        skip_llm=True,
    )
    out = run_feedback_triage(req)
    assert out.status in ("ok", "partial_awaiting_human", "awaiting_human")
    assert len(out.items) == 2
    by_id = {i.feedback_id: i for i in out.items}
    assert by_id[10].status == "applied"
    assert by_id[10].apply is True
    assert by_id[10].proposed_fix and by_id[10].proposed_fix.get("answer_cn") == "96"
    assert by_id[11].status == "dismissed"
    assert by_id[11].decision == "dismiss"
