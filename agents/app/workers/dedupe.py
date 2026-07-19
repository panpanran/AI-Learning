from __future__ import annotations

import hashlib
import json
from typing import Any

from app.samples import extract_bilingual_options, normalize_text


def compute_content_options_hash(content_en: str, options_en: list[str]) -> str:
    payload = json.dumps(
        {"content_en": normalize_text(content_en), "options": [normalize_text(x) for x in options_en]},
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def ensure_content_hash(question: dict[str, Any]) -> dict[str, Any]:
    if question.get("content_options_hash"):
        return question
    bilingual = extract_bilingual_options(question.get("options"))
    if not bilingual:
        return question
    question = dict(question)
    question["content_options_hash"] = compute_content_options_hash(
        question.get("content_en") or "", bilingual["en"]
    )
    return question


def unique_by_hash(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for q in questions:
        q2 = ensure_content_hash(dict(q))
        h = q2.get("content_options_hash")
        if not h or h in seen:
            continue
        seen.add(h)
        out.append(q2)
    return out


def dedupe_questions(
    questions: list[dict[str, Any]],
    *,
    existing_hashes: set[str] | None = None,
    db_hashes: set[str] | None = None,
) -> dict[str, Any]:
    """Hash-based dedupe (Phase C DedupeWorker)."""
    existing = existing_hashes or set()
    in_db = db_hashes or set()
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []

    for q in unique_by_hash(questions):
        h = q.get("content_options_hash")
        if not h:
            rejected.append({**q, "reject_reason": "missing_hash"})
            continue
        if h in existing:
            rejected.append({**q, "reject_reason": "duplicate_in_batch"})
            continue
        if h in in_db:
            rejected.append({**q, "reject_reason": "duplicate_in_db"})
            continue
        existing.add(h)
        accepted.append(q)

    return {
        "accepted": accepted,
        "rejected": rejected,
        "need_regenerate": max(0, len(rejected)),
    }
