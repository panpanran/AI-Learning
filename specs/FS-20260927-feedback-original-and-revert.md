# Feature Spec: Feedback review shows the original question and can reject applied fixes

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20260927-feedback-original-and-revert |
| **PR** | — |
| **Title** | Show original question + answer on `/feedback`; Reject reverts an applied fix |
| **Feature Key** | Feedback, UI |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-09-27 |
| **Packages** | backend, frontend |
| **Created** | 2026-09-27 |
| **Ready** | 2026-09-27 (human approved in chat) |
| **Implemented** | 2026-09-27 |

## 1. Intent

**Problem:**

- `/feedback` shows only the *current* question row. After a fix is applied (auto-apply is on by default, or a human Accept), `questions.*` is overwritten and the original stem, options and answer are gone. The page cannot show what the child actually saw.
- Reject is only enabled for `open` / `acknowledged`. `applied` rows show only Re-analyze; AI-`dismissed` rows show only Accept. In practice most rows are `applied` or `dismissed`, so the parent can accept but never reject.

**Outcome:** Each feedback card shows the original question (stem, options, answer, explanation) as it was before any fix, next to the current / proposed version. Reject on an `applied` row restores the original question and rescores history.

**In scope:** snapshot column; snapshot on every apply path; list returns snapshot; Reject reverts applied; options rendered on the card; button states per status.

**Out of scope:** recovering originals for rows applied before this ships (no data exists); multi-step undo history; admin roles.

## 2. Context for agents (non-negotiables)

- Stack: Vite React (`frontend/`), Express + Neon (`backend/`).
- Live question-bank writes stay limited to content / answer / explanation (never options, KP, metadata).
- Answer changes must keep rescoring `history.correct` (FS-20260919-history-rescore-after-feedback).

## 3. Acceptance criteria (testable)

1. **AC-1** — Given a feedback row with no snapshot, When any apply path writes `questions` (human Accept, Express auto-apply, agents auto-apply), Then `user_question_feedback.original_snapshot` stores the pre-write `content_*`, `answer_*`, `explanation_*`, `options`.
2. **AC-2** — Given a row that already has a snapshot, When a fix is applied again (Re-analyze then Accept), Then the snapshot is not overwritten.
3. **AC-3** — Given GET `/api/user-feedback`, Then each item includes `original` (snapshot, or `null`).
4. **AC-4** — Given an `applied` row with a snapshot, When Reject runs, Then `questions` CAE fields are restored from the snapshot, history is rescored, and status = `dismissed`.
5. **AC-5** — Given an `applied` row without a snapshot (legacy), When Reject runs, Then it returns 409 with a clear message and changes nothing.
6. **AC-6** — Given the `/feedback` card, Then it shows an "Original question" block (stem, options, answer, explanation) from `original`, falling back to the current row labeled as current when `original` is null; options are listed for both blocks.
7. **AC-7** — Button states: `open` / `acknowledged`: Accept + Reject + Re-analyze. `applied`: Reject (restore original; disabled with hint if no snapshot) + Re-analyze. `dismissed`: Accept + Re-analyze, with a "Rejected" label instead of a Reject button.

## 4. Open questions

| # | Question | Answer (who / when) |
|---|----------|---------------------|
| 1 | Reject on a legacy `applied` row with no snapshot: block (409) or just mark `dismissed` leaving the bank as is? | Block (AC-5). Ran Pan, 2026-09-27. |

## 5. Agent-executable engineering instructions

### Approach

1. `feedbackStore.ensure…`: `ALTER TABLE user_question_feedback ADD COLUMN IF NOT EXISTS original_snapshot JSONB`.
2. Helper `snapshotOriginalIfMissing(pool, feedbackId, question)`: `UPDATE … SET original_snapshot = $2 WHERE id = $1 AND original_snapshot IS NULL`. Call before `applyProposedFix` in the three apply paths (agents path loads the question row first).
3. `listUserFeedback`: select `f.original_snapshot`, return as `original`.
4. `decideUserFeedback` reject on `applied`: restore via `applyProposedFix(pool, qid, snapshot)` (CAE only), status `dismissed`, `proposed_fix || {human_decision:'reject', reverted:true}`. No snapshot: 409.
5. Frontend: original block + options list; button matrix per AC-7; i18n strings zh/en.

### Files / areas

| Path / area | Change |
|-------------|--------|
| `backend/lib/feedbackStore.js` | add column |
| `backend/lib/userFeedbackTriage.js` | snapshot helper, three apply paths, list, reject-revert |
| `backend/index.js` | map 409 in decide route |
| `backend/test/userFeedbackTriage.test.js` | AC-1..AC-5 |
| `frontend/src/FeedbackReview.tsx` | original block, options, buttons |
| `frontend/src/i18n.ts` | strings |

### API / UI contracts

| Surface | Behavior |
|---------|----------|
| GET `/api/user-feedback` | item gains `original: { content_cn, content_en, answer_cn, answer_en, explanation_cn, explanation_en, options } \| null` |
| POST `/api/user-feedback/:id/decide` `{action:'reject'}` | on `applied`: revert + `{status:'dismissed', reverted:true}`; no snapshot: 409 `{error}` |

### Data model

- Tables / columns: `user_question_feedback.original_snapshot JSONB NULL`
- Migration / ensureTables: `ADD COLUMN IF NOT EXISTS` at startup
- Rollback: column is additive; old code ignores it

### Error / result shape

- 409 `{ error: 'No original snapshot for this fix; cannot restore.' }`

## 6. Quality constraints

- i18n: all new labels zh + en.
- Revert must rescore history the same way apply does.

## 7. AC → verification map

| AC | Check | Result |
|----|-------|--------|
| AC-1 | unit: "accept stores the pre-fix question before updating it, guarded by IS NULL" | pass |
| AC-2 | same test asserts `original_snapshot IS NULL` guard | pass |
| AC-3 | unit: "list returns original_snapshot as original" | pass |
| AC-4 | unit: "reject on applied restores every CAE field from the snapshot and dismisses" | pass |
| AC-5 | unit: "reject on applied without a snapshot returns 409 and writes nothing" | pass |
| AC-6 | manual after deploy: `/feedback` card shows original block + options | pending (user) |
| AC-7 | manual after deploy: buttons per status | pending (user) |

## 8. Test plan

- Unit: vitest with mock pool in `userFeedbackTriage.test.js`.
- Build: `frontend> npm run build`.
- Manual after deploy: new feedback, let it auto-apply, confirm original shown, Reject restores.

## 9. Definition of Done

- [ ] FS was **Ready** before coding started
- [ ] All ACs verified (§7)
- [ ] **As-built** filled after implementation
- [ ] Diff scoped to this FS
- [ ] Status set to **Done** (or Follow-ups listed)
- [ ] No secrets in the diff

## 10. As-built (fill after code)

**What shipped:**

- `original_snapshot JSONB` added in `ensureUserQuestionFeedbackTable`.
- `applyFixWithSnapshot` (reads the question, writes the snapshot only if NULL, then `applyProposedFix`) replaces the direct apply call in human Accept, Express auto-apply and agents auto-apply.
- Reject on `applied` uses `restoreQuestionFromSnapshot`, which writes all six CAE fields verbatim (so fields the fix added are cleared) and rescores history; no snapshot returns 409, mapped in the decide route.
- `/feedback`: "Original question" and "Current question" blocks with options; proposed block hidden for `applied`; buttons per AC-7.

**How to run / verify:** `backend> npm test`; `frontend> npm run build`; after deploy open `/feedback`.

**Known limits / deltas vs plan:** rows applied before this ship have no snapshot, so Reject stays disabled with a hint. Options are never modified by fixes, so the snapshot's options are shown but not restored.

## 11. Evidence notes (fill after code / PR)

- Commands run: `backend> npm test` (25/25 pass, 4 new for this FS); `frontend> npx tsc --noEmit -p .` (no errors); `frontend> npm run build` (built).
- Output / CI link: local only.
- Review notes: AC-6 / AC-7 need a manual check on the deployed site.

## 12. Follow-ups (each needs its own FS later)

- …
