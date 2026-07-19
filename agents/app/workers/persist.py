from __future__ import annotations

import json
import os
from contextlib import contextmanager
from typing import Any, Generator

import psycopg2
from psycopg2.extras import RealDictCursor


def get_database_url() -> str:
    return (
        os.getenv("DATABASE_URL")
        or os.getenv("PG_CONNECTION_STRING")
        or ""
    ).strip()


@contextmanager
def db_connection() -> Generator[Any, None, None]:
    url = get_database_url()
    if not url:
        raise RuntimeError("DATABASE_URL not configured")
    conn = psycopg2.connect(url)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def fetch_hashes_in_db(hashes: list[str]) -> set[str]:
    if not hashes:
        return set()
    with db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT content_options_hash FROM questions WHERE content_options_hash = ANY(%s)",
                (hashes,),
            )
            return {str(row["content_options_hash"]) for row in cur.fetchall() if row.get("content_options_hash")}


def fetch_kp_usage_counts(
    student_user_ids: list[int],
    grade_id: int,
    subject_id: int,
    kp_ids: list[int],
) -> dict[int, int]:
    if not student_user_ids or not kp_ids:
        return {}
    with db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT q.knowledge_point_id, COUNT(*)::int AS cnt
                FROM history h
                JOIN questions q ON q.id = h.question_id
                WHERE h.user_id = ANY(%s)
                  AND q.grade_id = %s
                  AND q.subject_id = %s
                  AND q.knowledge_point_id = ANY(%s)
                GROUP BY q.knowledge_point_id
                """,
                (student_user_ids, grade_id, subject_id, kp_ids),
            )
            return {
                int(row["knowledge_point_id"]): int(row["cnt"])
                for row in cur.fetchall()
                if row.get("knowledge_point_id") is not None
            }


def persist_question(
    question: dict[str, Any],
    *,
    grade_id: int,
    subject_id: int,
) -> int | None:
    """Insert or upsert one question row (Phase C PersistWorker)."""
    with db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO questions(
                    content_cn, content_en, options, content_options_hash, metadata,
                    embedding, answer_cn, answer_en, explanation_cn, explanation_en,
                    knowledge_point_id, grade_id, subject_id
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (content_options_hash) DO UPDATE
                SET content_cn = EXCLUDED.content_cn,
                    content_en = EXCLUDED.content_en,
                    options = EXCLUDED.options,
                    metadata = EXCLUDED.metadata,
                    answer_cn = EXCLUDED.answer_cn,
                    answer_en = EXCLUDED.answer_en,
                    explanation_cn = EXCLUDED.explanation_cn,
                    explanation_en = EXCLUDED.explanation_en,
                    knowledge_point_id = EXCLUDED.knowledge_point_id,
                    grade_id = EXCLUDED.grade_id,
                    subject_id = EXCLUDED.subject_id
                RETURNING id
                """,
                (
                    question.get("content_cn"),
                    question.get("content_en"),
                    json.dumps(question.get("options")),
                    question.get("content_options_hash"),
                    json.dumps(question.get("metadata")) if question.get("metadata") else None,
                    question.get("embedding"),
                    question.get("answer_cn"),
                    question.get("answer_en"),
                    question.get("explanation_cn"),
                    question.get("explanation_en"),
                    question.get("knowledge_point_id"),
                    grade_id,
                    subject_id,
                ),
            )
            row = cur.fetchone()
            return int(row["id"]) if row and row.get("id") is not None else None
