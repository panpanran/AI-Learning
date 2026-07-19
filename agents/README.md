# Max AI Learning — Python Agents Service (Phase B)

FastAPI + LangGraph service for diagnostic quality evaluation, critic, and question refinement.

## Quick start

```powershell
cd maxailearning/agents
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --port 8001
```

Health check: `GET http://localhost:8001/health`

## Enable from Express

Add to `.env.local` (repo root):

```
AGENTS_SERVICE_URL=http://localhost:8001
DIAG_REFINE_ENABLED=1
DIAG_MAX_REFINE_ROUNDS=2
```

When `AGENTS_SERVICE_URL` is set, `ragasAuditor.js` delegates quality evaluation to this service.

When `AGENTS_DIAGNOSTIC_RUN=1`, Express in-memory diagnostic mode calls `POST /v1/diagnostic/run` (plan → generate → dedupe → evaluate → refine).

## API

### `POST /v1/diagnostic/quality/run`

Quality-only evaluation (Phase B).

### `POST /v1/diagnostic/run`

Full diagnostic generation pipeline (Phase C): planner → generator → dedupe → quality → optional refine.

Request body (excerpt):

```json
{
  "num_questions": 5,
  "kp_list": [...],
  "lang": "en",
  "student_profile": {},
  "grade_guidance": "",
  "feedback_context": {},
  "use_db_planner": true,
  "check_db_hashes": true,
  "persist": false,
  "enable_refine": true
}
```

### `POST /v1/diagnostic/quality/run` (legacy heading below)

Request body:

```json
{
  "questions": [...],
  "kp_list": [{"id": 1, "name_cn": "...", "name_en": "...", "description": "..."}],
  "lang": "en",
  "knowledge_point_ids_plan": [1, 2, 3],
  "grade_guidance": "",
  "max_refine_rounds": 2,
  "enable_refine": true
}
```

Response: `batch_id`, `batch` aggregates, per-question `rows` (rules + judge scores + critique), and optionally refined `questions`.

## Architecture

```
evaluate (rules + judge)
  → critic (build per-question critique)
  → refine (LLM rewrite low-score questions)
  → loop until pass or max_refine_rounds
```

See `specs/multi-agent-architecture.md` Phase B.
