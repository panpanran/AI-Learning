# Feature Spec — User feedback Phase 2 (triage + safe question fix)

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20260907-user-feedback-phase2 |
| **PR** | — |
| **Title** | Triage user_question_feedback; propose fixes; auto-apply only when safe |
| **Feature Key** | Feedback, Diagnostic, Eval |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-09-07 (“继续做吧” after Phase 1 data seen) |
| **Packages** | backend |
| **Created** | 2026-09-07 |
| **Ready** | 2026-09-07 |
| **Implemented** | 2026-09-07 |

## 1. Intent

**Problem:** Phase 1 stores parent comments but never corrects bad `questions` rows; wrong answers stay in the bank.  
**Outcome:** Each new (and optionally backlog) feedback is triaged: classify issue, write `proposed_fix`, and **auto-apply** only when a deterministic math check (or equally safe rule) confirms the bank answer/explanation is wrong. Ambiguous cases stay `acknowledged` with a proposal — never blind free-text overwrite.  
**In scope:** Backend triage after insert (async), math-safe apply, status transitions, enrich `user_reports` with triage outcome.  
**Out of scope:** Admin UI to approve proposals; new Python agent; rewriting options wholesale unless answer text must match an existing option; deleting questions.

## 2. Context

- Table already has `proposed_fix`, `status`, `applied_at`.
- Statuses: `open` → `acknowledged` (proposed, not applied) | `applied` | `dismissed`.
- Human gate: non-math / unverifiable cases must not auto-apply.

## 3. Acceptance criteria

1. **AC-1** — Given a new `user_question_feedback` insert, When triage runs, Then `category` is refined when possible and `proposed_fix` JSON is stored (or explicitly null with status `acknowledged` / `dismissed` if no change needed).
2. **AC-2** — Given math metadata `{type, nums}` where stored `answer_*` disagrees with the deterministic result and the correct value appears in options, When triage runs, Then `questions.answer_cn/en` (and explanation if proposed) are updated and feedback `status='applied'`.
3. **AC-3** — Given feedback that is subjective / non-verifiable, When triage runs, Then `questions` rows are **not** updated and status is `acknowledged` (or `dismissed` if clearly not a content bug).
4. **AC-4** — Given HTTP `POST /api/user-feedback`, When the client receives 200, Then the response is not blocked on OpenAI triage (triage is async / queued).

## 4. Open questions

| # | Question | Answer |
|---|----------|--------|
| 1 | Auto-apply non-math? | **No** this FS — only math-verifiable or “explanation-only” when answer already matches deterministic result. |

## 5. Engineering

### Approach

1. Add `backend/lib/userFeedbackTriage.js` — load question + feedback, LLM classify/propose, math verify, apply or acknowledge.
2. `queueUserFeedbackTriage` after successful insert in `/api/user-feedback`.
3. Optional one-shot: process existing `status='open'` rows (same function; call from script or on triage queue drain).
4. Extend `getUserReportsForPrompt` to include `status` + short `proposed_fix` summary when present.

### Files

| Path | Change |
|------|--------|
| `backend/lib/userFeedbackTriage.js` | New |
| `backend/lib/feedbackStore.js` | Export helpers / enrich reports |
| `backend/index.js` | Queue triage after insert |
| `backend/scripts/triage_open_user_feedback.js` | Backfill open rows |

### Data

- `user_question_feedback.proposed_fix` shape:
  `{ answer_cn?, answer_en?, explanation_cn?, explanation_en?, reason?, confidence?, auto_applicable? }`
- `questions` update only on apply path.

## 7. AC → verification map

| AC | Check | Result |
|----|-------|--------|
| AC-1 | Insert + wait; row has proposed_fix or dismissed reason | **pass** (code + backfill → acknowledged with proposed_fix) |
| AC-2 | Fixture math wrong answer → applied | **pass** (unit: `canAutoApplyMath` + buildMathProposedFix) |
| AC-3 | Vague / non-verifiable → acknowledged, questions unchanged | **pass** (backfill: 1 open → acknowledged) |
| AC-4 | API returns before triage completes | **pass** (`queueUserFeedbackTriage` after `res.json`) |

## 9. Definition of Done

- [x] Ready before code  
- [x] ACs verified  
- [x] As-built + Evidence  
- [x] Status Done  

## 10. As-built

**What shipped:**
- `backend/lib/userFeedbackTriage.js` — math verify + LLM classify; auto-apply only when math-safe
- `POST /api/user-feedback` queues async triage (`triage: queued`)
- `backend/scripts/triage_open_user_feedback.js` — backfill `status=open`
- `user_reports` now include `status` + `proposed_summary`
- Unit tests: `backend/test/userFeedbackTriage.test.js`

**How to run:**
```powershell
cd backend
npx vitest run test/userFeedbackTriage.test.js
node scripts/triage_open_user_feedback.js --limit 50
```

**Env:** `USER_FEEDBACK_AUTO_APPLY=0` disables DB writes to `questions` (still proposes).

## 11. Evidence

- vitest: 4 passed
- backfill 2026-09-07: `triaged 1 { acknowledged: 1 }`

## 12. Follow-ups

- Parent/admin UI to accept `acknowledged` proposals  
- Agents-service shared triage (optional)  
