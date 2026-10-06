"""Propose CAE-only fixes for parent/student question feedback.

Ports policy from backend/lib/userFeedbackTriage.js (math verify + LLM).
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

from openai import OpenAI

from app.config import OPENAI_API_KEY, OPENAI_MODEL


def normalize_answer_text(s: Any) -> str:
    text = str(s or "").strip().lower().replace(",", "")
    return re.sub(r"\s+", " ", text)


# A digit, '.' or '/' right after a numeric match means a different number ("500" is not "50", "3/4" is not "3").
_NUMERIC_CONTINUATION = re.compile(r"[0-9./]")


def _starts_with_at_boundary(long: str, short: str) -> bool:
    if not long.startswith(short):
        return False
    nxt = long[len(short):len(short) + 1]
    return not nxt or not _NUMERIC_CONTINUATION.match(nxt)


def _contains_at_boundary(hay: str, needle: str) -> bool:
    i = hay.find(needle)
    while i >= 0:
        before = hay[i - 1] if i > 0 else ""
        after = hay[i + len(needle):i + len(needle) + 1]
        if (not before or not _NUMERIC_CONTINUATION.match(before)) and (
            not after or not _NUMERIC_CONTINUATION.match(after)
        ):
            return True
        i = hay.find(needle, i + 1)
    return False


def answers_match(a: Any, b: Any) -> bool:
    x = normalize_answer_text(a)
    y = normalize_answer_text(b)
    if not x or not y:
        return False
    if x == y:
        return True
    try:
        return float(x) == float(y)
    except ValueError:
        pass
    return _starts_with_at_boundary(x, y) or _starts_with_at_boundary(y, x)


def parse_metadata(raw: Any) -> dict[str, Any] | None:
    if not raw:
        return None
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(str(raw))
        return parsed if isinstance(parsed, dict) else None
    except (TypeError, json.JSONDecodeError):
        return None


# Estimation questions are answered from rounded operands, so the exact result is not the bank answer.
_ESTIMATION_CONTEXT = re.compile(r"estimat|round|approx|估算|四舍五入|近似", re.IGNORECASE)


def compute_math_result(metadata: dict[str, Any] | None) -> str | None:
    if not metadata:
        return None
    if _ESTIMATION_CONTEXT.search(str(metadata.get("context") or "")):
        return None
    typ = str(metadata.get("type") or "").lower()
    nums_raw = metadata.get("nums")
    if not isinstance(nums_raw, list):
        return None
    nums = [float(n) for n in nums_raw if _is_finite_number(n)]
    if not nums:
        return None

    value: float | None = None
    if typ == "addition":
        value = sum(nums)
    elif typ == "subtraction" and len(nums) >= 2:
        value = nums[0] - nums[1]
    elif typ == "multiplication":
        value = 1.0
        for n in nums:
            value *= n
    elif typ == "division" and len(nums) >= 2 and nums[1] != 0:
        value = nums[0] / nums[1]
    else:
        return None

    if value is None or not _is_finite_number(value):
        return None
    if abs(value - round(value)) < 1e-9:
        return str(int(round(value)))
    return str(float(f"{value:.6f}")).rstrip("0").rstrip(".") if "." in f"{value:.6f}" else str(value)


def _is_finite_number(n: Any) -> bool:
    try:
        f = float(n)
        return f == f and f not in (float("inf"), float("-inf"))
    except (TypeError, ValueError):
        return False


def extract_option_texts(options: Any) -> list[str]:
    out: list[str] = []
    parsed = options
    if isinstance(options, str):
        try:
            parsed = json.loads(options)
        except json.JSONDecodeError:
            return out
    if isinstance(parsed, list):
        return [str(o) for o in parsed]
    if isinstance(parsed, dict):
        for lang in ("zh", "en", "cn"):
            arr = parsed.get(lang)
            if isinstance(arr, list):
                out.extend(str(o) for o in arr)
    return out


def find_matching_option(options: Any, expected: Any) -> str | None:
    texts = extract_option_texts(options)
    for t in texts:
        if answers_match(t, expected):
            return t
    exp = normalize_answer_text(expected)
    for t in texts:
        if exp and _contains_at_boundary(normalize_answer_text(t), exp):
            return t
    return None


def build_math_proposed_fix(question: dict[str, Any], expected: str) -> dict[str, Any]:
    options = question.get("options")
    answer_cn = find_matching_option(
        options.get("zh") if isinstance(options, dict) else options,
        expected,
    ) or expected
    answer_en = find_matching_option(
        options.get("en") if isinstance(options, dict) else options,
        expected,
    ) or expected
    if isinstance(options, dict):
        if isinstance(options.get("zh"), list):
            hit = next((t for t in options["zh"] if answers_match(t, expected)), None)
            if hit:
                answer_cn = hit
        if isinstance(options.get("en"), list):
            hit = next((t for t in options["en"] if answers_match(t, expected)), None)
            if hit:
                answer_en = hit
    return {
        "answer_cn": answer_cn,
        "answer_en": answer_en,
        "explanation_cn": f"根据题目数据计算，正确答案应为 {expected}。",
        "explanation_en": f"Based on the question data, the correct answer is {expected}.",
        "reason": f"math_verify expected={expected}",
        "confidence": 1.0,
        "source": "math_verify",
    }


def has_cae_change(proposed: dict[str, Any] | None) -> bool:
    if not proposed:
        return False
    return any(
        proposed.get(k)
        for k in (
            "content_cn",
            "content_en",
            "answer_cn",
            "answer_en",
            "explanation_cn",
            "explanation_en",
        )
    )


def proposed_answers_consistent_with_options(
    question: dict[str, Any],
    proposed: dict[str, Any],
) -> bool:
    options = question.get("options")
    if not options:
        return True
    ok = True
    if proposed.get("answer_cn"):
        zh_opts = options.get("zh") if isinstance(options, dict) else options
        if extract_option_texts(zh_opts if not isinstance(options, dict) else {"zh": options.get("zh")}):
            if not find_matching_option(
                {"zh": options.get("zh")} if isinstance(options, dict) else options,
                proposed["answer_cn"],
            ):
                # also try full options blob
                if not find_matching_option(options, proposed["answer_cn"]):
                    ok = False
    if proposed.get("answer_en"):
        if not find_matching_option(
            {"en": options.get("en")} if isinstance(options, dict) else options,
            proposed["answer_en"],
        ):
            if not find_matching_option(options, proposed["answer_en"]):
                ok = False
    return ok


def can_auto_apply_math(question: dict[str, Any], proposed: dict[str, Any] | None) -> bool:
    if not proposed or not (proposed.get("answer_cn") or proposed.get("answer_en")):
        return False
    if proposed.get("source") not in ("math_verify", "math_verify+llm"):
        return False
    return proposed_answers_consistent_with_options(question, proposed)


def can_auto_apply_llm(
    question: dict[str, Any],
    proposed: dict[str, Any] | None,
    confidence: float | None,
    min_confidence: float,
) -> bool:
    if not has_cae_change(proposed):
        return False
    if confidence is None or confidence < min_confidence:
        return False
    if proposed and (proposed.get("answer_cn") or proposed.get("answer_en")):
        return proposed_answers_consistent_with_options(question, proposed)
    return True


def _parse_json(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                return None
    return None


def llm_propose_fix(
    question: dict[str, Any],
    feedback: dict[str, Any],
    *,
    client: OpenAI | None = None,
) -> dict[str, Any] | None:
    if not OPENAI_API_KEY and client is None:
        return None
    openai_client = client or OpenAI(api_key=OPENAI_API_KEY)
    model = OPENAI_MODEL or os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
    payload = {
        "comment": feedback.get("comment"),
        "category_hint": feedback.get("category"),
        "given_answer": feedback.get("given_answer"),
        "question": {
            "content_cn": question.get("content_cn"),
            "content_en": question.get("content_en"),
            "answer_cn": question.get("answer_cn"),
            "answer_en": question.get("answer_en"),
            "explanation_cn": question.get("explanation_cn"),
            "explanation_en": question.get("explanation_en"),
            "options": question.get("options"),
            "metadata": question.get("metadata"),
        },
    }
    completion = openai_client.chat.completions.create(
        model=model,
        temperature=0,
        max_tokens=1200,
        messages=[
            {
                "role": "system",
                "content": (
                    "You triage parent feedback on a multiple-choice question. Return strict JSON only. "
                    "You may fix ONLY these fields: question stem (content), correct answer, and explanation "
                    "(both Chinese and English). Do NOT invent new options, change option lists, KP, or metadata. "
                    "If the answer changes, it MUST match an existing option text. "
                    "If no existing option is correct, or two options are equally correct (a tie), do NOT pick one: "
                    "set category=wrong_question, dismiss=false, proposed_fix=null, and say in reason that the options have no single correct answer. "
                    "Rounding: tens digit 0-4 → round down; 5-9 → round up. Example: 548→500, 639→600, sum=1100. "
                    "reason must be ONE short coherent sentence (max 200 chars). Never contradict yourself. "
                    "If bank answer+explanation are already correct, set dismiss=true, category=not_a_bug, proposed_fix=null. "
                    "If feedback is about student difficulty (not a content bug), set dismiss=true."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Return JSON schema:\n"
                    "{\n"
                    '  "category": "wrong_answer|wrong_explanation|wrong_content|unclear|too_hard|too_easy|not_a_bug|other",\n'
                    '  "dismiss": boolean,\n'
                    '  "confidence": number 0-1,\n'
                    '  "reason": string,\n'
                    '  "proposed_fix": {\n'
                    '    "content_cn": string|null, "content_en": string|null,\n'
                    '    "answer_cn": string|null, "answer_en": string|null,\n'
                    '    "explanation_cn": string|null, "explanation_en": string|null\n'
                    "  }\n"
                    "}\n\n"
                    f"Input:\n{json.dumps(payload, ensure_ascii=False)}"
                ),
            },
        ],
        response_format={"type": "json_object"},
    )
    content = completion.choices[0].message.content or ""
    return _parse_json(content)


def propose_for_item(
    item: dict[str, Any],
    *,
    client: OpenAI | None = None,
    skip_llm: bool = False,
) -> dict[str, Any]:
    """Return propose node output for one feedback+question item."""
    feedback_id = item.get("feedback_id")
    question = dict(item.get("question") or {})
    feedback = {
        "comment": item.get("comment"),
        "category": item.get("category") or "other",
        "given_answer": item.get("given_answer"),
    }
    question_id = item.get("question_id") or question.get("id")

    if not question:
        return {
            "feedback_id": feedback_id,
            "question_id": question_id,
            "category": "other",
            "dismiss": True,
            "proposed_fix": {"reason": "question_missing", "confidence": 1},
            "decision_hint": "dismiss",
        }

    expected = compute_math_result(parse_metadata(question.get("metadata")))
    proposed: dict[str, Any] | None = None
    category = str(feedback.get("category") or "other")
    dismiss = False
    llm: dict[str, Any] | None = None

    given = str(feedback.get("given_answer") or "").strip()
    bank_matches_given = bool(given) and (
        answers_match(given, question.get("answer_cn"))
        or answers_match(given, question.get("answer_en"))
    )
    if bank_matches_given:
        return {
            "feedback_id": feedback_id,
            "question_id": question_id,
            "question": question,
            "category": "other",
            "dismiss": False,
            "proposed_fix": {
                "answer_cn": question.get("answer_cn") or given,
                "answer_en": question.get("answer_en") or given,
                "explanation_cn": question.get("explanation_cn"),
                "explanation_en": question.get("explanation_en"),
                "reason": "Bank answer already matches the given answer. No change needed.",
                "confidence": 1.0,
                "source": "already_correct",
            },
            "llm": None,
        }

    if expected:
        stored_ok = answers_match(question.get("answer_cn"), expected) or answers_match(
            question.get("answer_en"), expected
        )
        # A computed value outside the options cannot be the bank answer; leave the call to the LLM.
        in_options = not question.get("options") or bool(
            find_matching_option(question.get("options"), expected)
        )
        if not stored_ok and in_options:
            proposed = build_math_proposed_fix(question, expected)
            category = "wrong_answer"

    if not skip_llm:
        try:
            llm = llm_propose_fix(question, feedback, client=client)
        except Exception as exc:  # noqa: BLE001 — triage must continue
            llm = {"error": str(exc)}

    if llm and isinstance(llm, dict) and "error" not in llm:
        if llm.get("category"):
            category = str(llm["category"])[:64]
        if llm.get("dismiss") is True:
            dismiss = True
        pf = llm.get("proposed_fix") if isinstance(llm.get("proposed_fix"), dict) else None
        if not proposed and pf:
            proposed = {
                **pf,
                "reason": llm.get("reason"),
                "confidence": float(llm["confidence"]) if llm.get("confidence") is not None else None,
                "source": "llm",
            }
        elif proposed and pf:
            for key in ("content_cn", "content_en", "explanation_cn", "explanation_en"):
                if pf.get(key):
                    proposed[key] = pf[key]
            if llm.get("reason"):
                proposed["reason"] = f"{proposed.get('reason') or ''}; {llm['reason']}".strip("; ")
            if llm.get("confidence") is not None and proposed.get("confidence") is None:
                proposed["confidence"] = float(llm["confidence"])
            proposed["source"] = proposed.get("source") or "math_verify+llm"
            if proposed.get("source") == "math_verify":
                proposed["source"] = "math_verify+llm"
        elif not proposed and llm.get("reason"):
            proposed = {
                "reason": llm.get("reason"),
                "confidence": float(llm["confidence"]) if llm.get("confidence") is not None else None,
                "source": "llm",
            }

    # A broken question (no single correct option) needs a human to retire it, so keep it pending.
    if category == "wrong_question" and not has_cae_change(proposed):
        dismiss = False

    return {
        "feedback_id": feedback_id,
        "question_id": question_id,
        "question": question,
        "category": category,
        "dismiss": dismiss,
        "proposed_fix": proposed,
        "llm": {k: llm.get(k) for k in ("category", "dismiss", "confidence", "reason")} if llm and "error" not in (llm or {}) else llm,
    }
