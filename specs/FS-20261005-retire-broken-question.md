# Feature Spec: Retire a broken question from the bank

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20261005-retire-broken-question |
| **PR** | — |
| **Title** | Parent can retire a question that has no single correct option, so diagnostics stop serving it |
| **Feature Key** | Feedback, Diagnostic, UI |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-10-05 (feedback #14 / Q2642) |
| **Packages** | backend, frontend, agents |
| **Created** | 2026-10-05 |
| **Ready** | 2026-10-05 (human approved in chat) |
| **Implemented** | 2026-10-05 |

## 1. Intent

**Problem:** Some bank questions cannot be fixed by changing the stem, answer or explanation, because the options themselves are wrong. Example Q2642: "Estimate 238 × 41 by rounding to the nearest ten" gives 9,600, which is not an option, and 9,400 and 9,800 are both 200 away. Fixes may not touch options, so today the only choice is Reject, and the broken question keeps being served.

**Outcome:** From the feedback card, the parent can retire the question. Retired questions are never served in a new diagnostic. Retiring is reversible.

**In scope:**

- `questions.retired_at`, `retired_reason`, `retired_by_feedback_id`.
- Retire / Unretire actions on the `/feedback` card.
- Exclude retired questions from bank selection for diagnostics.
- Stop a newly generated question with the same content hash from bringing a retired question back.
- Triage: when the LLM returns `category=wrong_question` with no fix, the card suggests Retire (human still clicks).

**Out of scope:**

- Auto-retire without a human click.
- Editing options or regenerating a replacement question.
- Removing the question from Pinecone (search and debug endpoints may still return it).
- Changing past history rows or KP scores (see open question 2).
- An admin page listing all retired questions.

## 2. Context for agents (non-negotiables)

- Stack: Vite React (`frontend/`), Express + Neon (`backend/`), FastAPI agents (`agents/`).
- Live question-bank changes stay human-decided: Retire is a human action only.
- Bank selection for diagnostics is `fetchUnusedQuestions` in `backend/index.js`.
- Generated questions are upserted by `content_options_hash` in five places: `backend/index.js` (two), `backend/routes/diagnostic.js`, `backend/lib/questionPersistWorker.js`, `agents/app/workers/persist.py`. Dedupe and avoid-list queries should keep seeing retired rows, so the generator stops producing near-copies.

## 3. Acceptance criteria (testable)

0. **AC-0:** Given a user whose username is not in the retire allowlist (`maxpan`, `panpanr`; overridable by env `RETIRE_ALLOWED_USERNAMES`, comma-separated), When POST retire or unretire, Then 403 and nothing changes; GET `/api/user-feedback` returns `can_retire=false` and the card shows no Retire / Unretire buttons.
1. **AC-1:** Given an allowlisted user and a feedback row the user owns, When POST `/api/user-feedback/:id/retire` with an optional reason, Then the question gets `retired_at = NOW()`, `retired_reason`, `retired_by_feedback_id = :id`; feedback status becomes `dismissed` with `proposed_fix || {human_decision:'retire'}`. Retiring an already retired question is a no-op success.
2. **AC-2:** Given a retired question, When POST `/api/user-feedback/:id/unretire`, Then `retired_at`, `retired_reason`, `retired_by_feedback_id` are cleared; feedback status is unchanged.
3. **AC-3:** Given retired questions in the bank, When a diagnostic selects bank questions (`fetchUnusedQuestions`), Then no retired question is returned.
4. **AC-4:** Given a newly generated question whose `content_options_hash` matches a retired question, When it is persisted, Then the retired row is not overwritten or un-retired, and that question is dropped from the diagnostic being built.
5. **AC-5:** Given GET `/api/user-feedback`, Then each item's `question` includes `retired_at` and `retired_reason`.
6. **AC-6:** Given the `/feedback` card, Then it shows a "Retire question" button when the question is not retired, and a "Retired" label plus an "Unretire" button when it is. When `category=wrong_question` and there is no CAE proposal, the card shows the hint "The options have no single correct answer. Consider retiring this question."
7. **AC-7:** Given the LLM triage returns `category=wrong_question` with `proposed_fix=null`, When triage finishes, Then status is `acknowledged` (not `dismissed`) so the parent sees it as pending.

## 4. Open questions

| # | Question | Answer (who / when) |
|---|----------|---------------------|
| 1 | Who may retire? | Only usernames `maxpan` and `panpanr` (and they must own the feedback row, as for Accept). Ran Pan, 2026-10-05. |
| 2 | Should past attempts on a retired question stop counting in KP scores and the history accuracy? | Keep counting; history unchanged. Ran Pan, 2026-10-05. |
| 3 | After Retire, should the feedback status be `dismissed` or a new status `retired` with its own filter tab? | `dismissed` plus a "Retired" label. Ran Pan, 2026-10-05. |

## 5. Agent-executable engineering instructions

### Approach

1. Startup `ALTER TABLE questions ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ, retired_reason TEXT, retired_by_feedback_id INTEGER` next to the existing ensure-tables code.
2. `userFeedbackTriage.js`: `retireQuestionForFeedback`, `unretireQuestionForFeedback` (ownership check like `decideUserFeedback`); list adds `q.retired_at, q.retired_reason`.
3. `index.js`: two routes; `fetchUnusedQuestions` adds `AND q.retired_at IS NULL`.
4. Upsert sites: add `WHERE questions.retired_at IS NULL` to `ON CONFLICT ... DO UPDATE`; in the diagnostic build paths, drop generated questions whose resolved id is retired (one `SELECT id FROM questions WHERE id = ANY($1) AND retired_at IS NOT NULL` after persisting).
5. Triage (Node + Python): `wrong_question` with no CAE stays `acknowledged`.
6. Frontend: buttons, label, hint; i18n zh + en.

### Files / areas

| Path / area | Change |
|-------------|--------|
| `backend/index.js` | column ensure, routes, `fetchUnusedQuestions` filter, upsert guard + drop retired |
| `backend/routes/diagnostic.js` | upsert guard + drop retired |
| `backend/lib/questionPersistWorker.js` | upsert guard |
| `backend/lib/userFeedbackTriage.js` | retire / unretire, list fields, `wrong_question` stays acknowledged |
| `agents/app/workers/persist.py` | upsert guard |
| `agents/app/agents/feedback_proposer.py` | `wrong_question` stays acknowledged |
| `backend/test/userFeedbackTriage.test.js` | AC-1, AC-2, AC-5, AC-7 |
| `frontend/src/FeedbackReview.tsx`, `frontend/src/i18n.ts` | AC-6 |

### API / UI contracts

| Surface | Behavior |
|---------|----------|
| POST `/api/user-feedback/:id/retire` `{reason?}` | 200 `{ok, question_id, retired_at}`; 403 not allowlisted; 404 not owner / missing |
| POST `/api/user-feedback/:id/unretire` | 200 `{ok, question_id}`; 403 not allowlisted; 404 not owner / missing |
| GET `/api/user-feedback` | `question.retired_at`, `question.retired_reason`; top-level `can_retire` |

### Data model

- Tables / columns: `questions.retired_at TIMESTAMPTZ NULL`, `questions.retired_reason TEXT NULL`, `questions.retired_by_feedback_id INTEGER NULL`.
- Migration / ensureTables: `ADD COLUMN IF NOT EXISTS` at startup.
- Rollback: additive; old code ignores the columns (retired questions would be served again).

### Error / result shape

- 404 `{ error: 'feedback not found' }` for missing or not-owned rows, same as decide.

## 6. Quality constraints

- The `fetchUnusedQuestions` filter must not reduce fill rate noticeably: retired rows are expected to be a handful.
- i18n: all new labels zh + en.

## 7. AC → verification map

| AC | Check | Result |
|----|-------|--------|
| AC-0 | unit: "allowlist is maxpan and panpanr", "non-allowlisted user gets 403 and nothing is written" | pass |
| AC-1 | unit: "retire marks the question and dismisses the feedback; repeat keeps the first values", "retire on someone else's feedback is 404" | pass |
| AC-2 | unit: "unretire clears the retired columns" | pass |
| AC-3 | code review: `fetchUnusedQuestions` has `AND q.retired_at IS NULL` (inside a route closure, not unit-testable without a refactor) | pass (review) |
| AC-4 | code review of the five upsert sites | pass (review) |
| AC-5 | unit: "list exposes retired_at and retired_reason on the question" | pass |
| AC-6 | manual after deploy on Q2642 | pending (user) |
| AC-7 | unit: "LLM wrong_question with no fix stays acknowledged even if it says dismiss" | pass |

## 8. Test plan

- Unit: vitest with mock pool.
- Build: `frontend> npm run build`.
- Manual after deploy: retire Q2642 from feedback #14; run a diagnostic on that KP and confirm Q2642 does not appear; unretire and confirm it can appear again.

## 9. Definition of Done

- [ ] FS was **Ready** before coding started
- [ ] All ACs verified (§7)
- [ ] **As-built** filled after implementation
- [ ] Diff scoped to this FS
- [ ] Status set to **Done** (or Follow-ups listed)
- [ ] No secrets in the diff

## 10. As-built (fill after code)

**What shipped:**

- `questions.retired_at / retired_reason / retired_by_feedback_id` added at startup in `ensureTables` (`backend/index.js`).
- `userFeedbackTriage.js`: `canRetireQuestions` (allowlist from `RETIRE_ALLOWED_USERNAMES`, default `maxpan,panpanr`), `retireQuestionForFeedback` (COALESCE keeps the first retire values), `unretireQuestionForFeedback`; list returns `question.retired_at / retired_reason`; local triage forces `dismiss=false` for `wrong_question` without a CAE change.
- Routes `POST /api/user-feedback/:id/retire|unretire`; GET list returns `can_retire`. A shared `resolveFeedbackUser` helper resolves user ids + username.
- Serving: `fetchUnusedQuestions` filters `q.retired_at IS NULL`.
- Upserts (`index.js` x2, `routes/diagnostic.js`, `questionPersistWorker.js`, `agents/app/workers/persist.py`): `ON CONFLICT ... DO UPDATE ... WHERE questions.retired_at IS NULL`, and the follow-up `SELECT id ... AND retired_at IS NULL`, so a regenerated copy of a retired question gets no id and is skipped (the existing "no stable id, skip" branch).
- Agents `feedback_proposer.py`: `wrong_question` without CAE keeps `dismiss=False`.
- `/feedback`: Retire / Unretire button (only when `can_retire`), "Retired" label, suggestion hint for `wrong_question`; confirm dialog before retiring.

**How to run / verify:** `backend> npm test`; `frontend> npm run build`; after deploy, log in as `maxpan` or `panpanr`, open `/feedback`, retire Q2642 from feedback #14.

**Known limits / deltas vs plan:** the "drop retired" step is done by the existing skip-if-no-id branch instead of a separate post-persist query. The agents `/diagnostic/run` returns questions without an id when `persist=true` hits a retired row; Express calls it with `persist:false` and persists itself, so this path is not used today.

## 11. Evidence notes (fill after code / PR)

- Commands run: `backend> npm test` (35/35 pass, 7 new for this FS); `frontend> npm run build` (built); `frontend> npx tsc --noEmit` (only the existing `QuestionChart.tsx` error); `agents> python -c "import app.workers.persist, app.agents.feedback_proposer"` (imports OK; pytest not installed).
- Output / CI link: local only.
- Review notes: AC-6 needs a manual check on the deployed site.

## 12. Follow-ups (each needs its own FS later)

- The `content_options_hash` upsert overwrites `content_*`, `options`, `answer_*`, `explanation_*` on conflict. A regenerated copy of a question that a parent already fixed can silently undo the fix. Needs its own FS (likely: never overwrite CAE fields on conflict for rows with an applied feedback).
- Admin view of retired questions across the bank.
