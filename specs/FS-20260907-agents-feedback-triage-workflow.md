# Feature Spec — Agents feedback triage workflow

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20260907-agents-feedback-triage-workflow |
| **PR** | — |
| **Title** | Parent feedback correction as agents LangGraph workflow (batch + human gate) |
| **Feature Key** | Feedback, Agent, Eval, Deploy |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-09-07 — upgrade Express one-shot LLM to agents workflow |
| **Packages** | agents, backend, frontend (batch button) |
| **Created** | 2026-09-07 |
| **Ready** | 2026-09-07 (human:「写FS然后完整做出来」) |
| **Implemented** | 2026-09-07 |

## 1. Intent

**Problem:** Parent feedback triage lives as a one-off OpenAI call inside Express (`userFeedbackTriage.js`). It cannot batch cleanly, does not share the agents deploy/model/eval surface used by diagnostic generation, and “pause for human” is only an implicit DB status.  

**Outcome:** Feedback correction runs on the **agents** service as a LangGraph workflow: propose (math + LLM) → gate (auto-apply / await human / dismiss) → results Express persists. Human approval remains the existing `/feedback` UI + decide API (durable interrupt via `acknowledged`). Batch triage of many open rows in one agents call.  

**In scope:**
- Agents: `POST /v1/feedback/triage` real workflow (replace stub)
- LangGraph: propose → gate (per item)
- Math verify + CAE-only LLM propose (same policy as FS-20260907-feedback-ai-apply-cae)
- Express: prefer agents when enabled; fallback to local triage
- Batch: Express helper + script/API to triage many `open`/`acknowledged` rows in one call
- Env flags aligned with diagnostic agents (`AGENTS_SERVICE_URL`, `AGENTS_FEEDBACK_TRIAGE`)

**Out of scope:**
- Changing `options` / KP / metadata
- Durable LangGraph checkpointer across process restarts (human pause = DB `acknowledged` + review UI)
- Multi-tenant admin roles
- Full critic/refine loop on bank questions (optional follow-up)
- Frontend redesign beyond existing review page

## 2. Context for agents (non-negotiables)

- Stack: Vite React (`frontend/`), Express + Neon (`backend/`), FastAPI agents (`agents/`).
- CAE-only writes: `content_*`, `answer_*`, `explanation_*`.
- Auto-apply still gated by math-safe or LLM confidence ≥ threshold + answers ∈ options.
- Secrets stay in `.env.local`; never commit API keys.
- Live bank auto-correction without a human gate only when existing auto-apply policy says so.

## 3. Acceptance criteria (testable)

1. **AC-1** — Given agents service up and `AGENTS_FEEDBACK_TRIAGE` enabled, When Express triages one feedback id, Then it calls `POST /v1/feedback/triage` (not only local `llmProposeFix`) and persists the returned status/`proposed_fix`.
2. **AC-2** — Given N feedback items in one request (`1 < N ≤ 20`), When agents triage runs, Then each item gets an independent result (`applied` | `acknowledged` | `dismissed` | skipped).
3. **AC-3** — Given a proposal that fails auto-apply gates, When gate runs, Then status is `acknowledged` with `proposed_fix` (await human via existing review UI); questions unchanged.
4. **AC-4** — Given math metadata with wrong bank answer, When propose runs, Then deterministic math still drives `answer_*` (same CAE policy).
5. **AC-5** — Given agents unreachable or flag off, When triage runs, Then Express local path still works (fallback).
6. **AC-6** — Given batch triage entry (script or authenticated API), When invoked for open rows, Then multiple ids are sent in one agents batch (or sequential agents calls with shared client) and DB updated.

## 4. Open questions

| # | Question | Answer |
|---|----------|--------|
| 1 | Durable LangGraph interrupt? | Deferred — use DB `acknowledged` + `/feedback` as human node |
| 2 | Default enable when URL set? | Yes: on if `AGENTS_SERVICE_URL` set and `AGENTS_FEEDBACK_TRIAGE` ≠ `0` |

## 5. Agent-executable engineering instructions

### Approach

1. Port math + CAE propose + gate helpers into `agents/` (Python).
2. Build LangGraph: `propose` → `gate` → END; return `batch_id` + per-item results.
3. Wire FastAPI models + replace stub endpoint.
4. Extend `backend/lib/agentClient.js`; teach `userFeedbackTriage.js` to prefer agents then apply DB updates; keep local fallback.
5. Add batch loader (script + optional `POST /api/user-feedback/triage-batch`).
6. Unit-test math/gate without OpenAI; smoke-import graph.

### Files / areas

| Path / area | Change |
|-------------|--------|
| `agents/app/agents/feedback_proposer.py` | math + LLM CAE propose |
| `agents/app/orchestrators/feedback_triage.py` | LangGraph workflow |
| `agents/app/models.py` + `main.py` | request/response + route |
| `agents/tests/test_feedback_gate.py` | math/gate unit tests |
| `backend/lib/agentClient.js` | `runAgentsFeedbackTriage` |
| `backend/lib/userFeedbackTriage.js` | agents-first + apply results + batch |
| `backend/index.js` | `POST /api/user-feedback/triage-batch` |
| `backend/scripts/triage_open_user_feedback.js` | prefers agents batch |
| `frontend/src/FeedbackReview.tsx` + i18n | Batch re-triage button |

### API / UI contracts

| Surface | Behavior |
|---------|----------|
| `POST /v1/feedback/triage` | Body: `{ items: [{feedback_id, question_id, category, comment, given_answer, question:{…}}], auto_apply, min_confidence, meta }`. Response: `{ batch_id, status, items: [{feedback_id, question_id, status, category, proposed_fix, decision, apply}] }` |
| Express triage | Load row+question → agents (if enabled) → apply statuses to DB |
| `POST /api/user-feedback/triage-batch` | Auth; triage caller’s `open`/`acknowledged` up to `limit` via agents/local |
| `/feedback` UI | Human node for `acknowledged` + batch button |

### Data model

- Tables / columns: `none` (reuse `user_question_feedback`, `questions`)
- Migration: `none`
- Rollback: `AGENTS_FEEDBACK_TRIAGE=0`

## 6. Quality constraints

- Batch size capped at 20 per call
- CAE-only; option consistency for auto-apply
- Same OpenAI model env as agents (`OPENAI_MODEL`)
- Timeout: `AGENTS_FEEDBACK_TIMEOUT_MS` or `AGENTS_SERVICE_TIMEOUT_MS` (default 300s)

## 7. AC → verification map

| AC | Check | Result |
|----|-------|--------|
| AC-1 | `triageUserFeedbackById` → `runAgentsFeedbackTriage` then `applyAgentsTriageResults` | **pass** (code) |
| AC-2 | `test_batch_gate_await_human_without_llm` (2 items) | **pass** |
| AC-3 | Low-conf gate unit + gate → `acknowledged` / `await_human` | **pass** |
| AC-4 | Math multiplication → applied answer 96 | **pass** |
| AC-5 | try/catch fallback to `triageUserFeedbackLocally` | **pass** (code) |
| AC-6 | `triageOpenUserFeedback` chunks + `POST …/triage-batch` + UI button | **pass** (code) |

## 8. Test plan

- `cd agents; $env:PYTHONPATH='.'; python -m pytest tests/test_feedback_gate.py -q` → 4 passed
- Node: require agentClient + userFeedbackTriage

## 9. Definition of Done

- [x] FS Ready before coding (human authorize)
- [x] All ACs verified in §7
- [x] As-built filled
- [x] Diff scoped to this FS (+ thin UI batch glue)
- [x] Status Done
- [x] No secrets in diff

## 10. As-built

**What shipped:**
- Agents LangGraph `propose → gate` at `POST /v1/feedback/triage`
- Express prefers agents when `AGENTS_SERVICE_URL` set and `AGENTS_FEEDBACK_TRIAGE≠0`; persists results; local fallback
- Batch: script, `POST /api/user-feedback/triage-batch`, Feedback review “批量重新分析”
- Human pause: still `acknowledged` + `/feedback` Accept/Reject (`proposed_fix.workflow=agents_feedback_triage`, `batch_id`)

**How to run / verify:**
1. Deploy/restart agents with this code; ensure backend `AGENTS_SERVICE_URL` points at it.
2. Leave `AGENTS_FEEDBACK_TRIAGE` unset or `1`.
3. Submit feedback or open `/feedback` → Batch re-triage; check `proposed_fix.batch_id`.
4. `cd agents; $env:PYTHONPATH='.'; python -m pytest tests/test_feedback_gate.py -q`

**Known limits / deltas vs plan:**
- No durable LangGraph checkpointer (by design this slice)
- Frontend only gained a batch button (no redesign)

## 11. Evidence notes

- Commands run: `python -m pytest tests/test_feedback_gate.py -q` → `4 passed in 0.88s`
- Node module load of `runAgentsFeedbackTriage` / `triageUserFeedbackBatch` OK

## 12. Follow-ups (own FS later)

- Durable LangGraph checkpointer + `POST /v1/feedback/resume`
- Optional critic/refine on proposed CAE using diagnostic quality graph
- Agents-side apply when Express is down
