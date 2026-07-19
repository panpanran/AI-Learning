from __future__ import annotations

import json
import os
from typing import Any

from openai import OpenAI

from app.config import DIAG_EVAL_MODEL, OPENAI_API_KEY

DEFAULT_METRICS = ["kp_alignment", "explanation_support", "distractor_quality"]


def _parse_json(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
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


def _build_prompt(sample: dict[str, Any], metrics: list[str]) -> str:
    ctx = sample.get("eval_context") or {}
    lines = [
        "Evaluate this diagnostic multiple-choice question.",
        "",
        f"Question: {sample.get('question', '')}",
        f"Correct answer: {sample.get('answer', '')}",
        f"Explanation: {sample.get('explanation', '')}",
        f"Options: {json.dumps(sample.get('options', []), ensure_ascii=False)}",
        "",
        "Assigned knowledge point:",
        f"- id: {ctx.get('kp_id', 'unknown')}",
        f"- name: {ctx.get('kp_name', '')}",
        f"- unit: {ctx.get('unit_name', '')}",
        f"- description: {ctx.get('description', '')}",
        "",
        "Return JSON with this shape:",
        "{",
        '  "kp_alignment": { "score": 0.0-1.0, "reason": "..." },',
        '  "explanation_support": { "pass": true|false, "reason": "..." },',
        '  "distractor_quality": { "score": 0.0-1.0, "reason": "..." }',
        "}",
        "",
        "Scoring guidance:",
        "- kp_alignment: 1 = question primarily tests the assigned KP; 0 = tests a different skill/topic.",
        "- explanation_support: pass if the explanation logically supports the marked correct answer.",
        "- distractor_quality: 1 = three wrong options are plausible but clearly incorrect.",
    ]
    if ctx.get("grade_guidance"):
        lines.insert(8, f"- grade guidance: {ctx['grade_guidance']}")
    _ = metrics
    return "\n".join(lines)


def _normalize(parsed: dict[str, Any], metrics: list[str]) -> dict[str, Any]:
    scores: dict[str, Any] = {}
    reasons: dict[str, str] = {}
    kp = parsed.get("kp_alignment") if isinstance(parsed.get("kp_alignment"), dict) else None
    if "kp_alignment" in metrics and kp:
        score = kp.get("score")
        if isinstance(score, (int, float)):
            scores["kp_alignment"] = max(0.0, min(1.0, float(score)))
        if kp.get("reason"):
            reasons["kp_alignment"] = str(kp["reason"])

    expl = parsed.get("explanation_support") if isinstance(parsed.get("explanation_support"), dict) else None
    if "explanation_support" in metrics and expl:
        if "pass" in expl:
            scores["explanation_support"] = bool(expl["pass"])
        if expl.get("reason"):
            reasons["explanation_support"] = str(expl["reason"])

    dist = parsed.get("distractor_quality") if isinstance(parsed.get("distractor_quality"), dict) else None
    if "distractor_quality" in metrics and dist:
        score = dist.get("score")
        if isinstance(score, (int, float)):
            scores["distractor_quality"] = max(0.0, min(1.0, float(score)))
        if dist.get("reason"):
            reasons["distractor_quality"] = str(dist["reason"])

    return {"scores": scores or None, "judge_reasons": reasons or None}


def judge_sample(sample: dict[str, Any], metrics: list[str] | None = None, model: str | None = None) -> dict[str, Any]:
    if not OPENAI_API_KEY:
        return {"scores": None, "judge_reasons": None, "error": "OpenAI not configured"}
    active = metrics or DEFAULT_METRICS
    client = OpenAI(api_key=OPENAI_API_KEY)
    model_name = model or DIAG_EVAL_MODEL or os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    messages = [
        {"role": "system", "content": "You evaluate educational MCQ quality. Respond with valid JSON only."},
        {"role": "user", "content": _build_prompt(sample, active)},
    ]
    try:
        completion = client.chat.completions.create(
            model=model_name,
            temperature=0,
            messages=messages,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        if "response_format" in str(exc).lower():
            completion = client.chat.completions.create(model=model_name, temperature=0, messages=messages)
        else:
            raise
    content = completion.choices[0].message.content or ""
    parsed = _parse_json(content)
    if not parsed:
        return {"scores": None, "judge_reasons": None, "error": "Failed to parse judge JSON"}
    return _normalize(parsed, active)


def run_diagnostic_judge(samples: list[dict[str, Any]]) -> dict[str, Any]:
    rows = []
    for sample in samples:
        try:
            rows.append(judge_sample(sample))
        except Exception as exc:
            rows.append({"scores": None, "judge_reasons": None, "error": str(exc)})

    def mean_field(field: str) -> float | None:
        vals = [r["scores"][field] for r in rows if r.get("scores") and isinstance(r["scores"].get(field), (int, float))]
        return round(sum(vals) / len(vals), 4) if vals else None

    support = [r for r in rows if r.get("scores") and isinstance(r["scores"].get("explanation_support"), bool)]
    support_rate = sum(1 for r in support if r["scores"]["explanation_support"]) / len(support) if support else None

    return {
        "rows": rows,
        "batch": {
            "mean_kp_alignment": mean_field("kp_alignment"),
            "mean_distractor_quality": mean_field("distractor_quality"),
            "explanation_support_rate": support_rate,
        },
    }
