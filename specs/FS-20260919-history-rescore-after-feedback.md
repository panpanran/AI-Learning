# Feature Spec — Rescore history after a question bank fix

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20260919-history-rescore-after-feedback |
| **PR** | — |
| **Title** | After feedback applies a new bank answer, rewrite `history.correct` so History / KP scores match |
| **Feature Key** | Feedback, Diagnostic, UI |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-09-19 (feedback `#5 · Q2345` applied; History still shows Wrong for 3/4 vs 3/4) |
| **Packages** | backend |
| **Created** | 2026-09-19 |
| **Ready** | 2026-09-19 (human: Ready) |
| **Implemented** | 2026-09-19 |

## 1. Intent

**Problem:** Accepting or auto-applying feedback updates `questions.answer_*` (and explanation/content), but `history.correct` stays the boolean written at submit time. History joins the live question row, so parents see the new correct answer next to the old Wrong badge. KP scores (`SUM(h.correct)`) stay wrong too. Q2345 is the live example: student answered `3/4`, bank answer is now `3/4`, badge is still Wrong.

**Outcome:** Whenever a bank answer is applied, every `history` row for that `question_id` is rescored with the same answer-matching rules used elsewhere. Already-applied questions (including Q2345) are backfilled. History and KP scores then show the updated verdict.

**In scope:** Persist `history.correct` after apply; helper + tests; one-shot backfill for already-applied questions.

**Out of scope:** Changing knowledge-point assignment on the question (Q2345 still tagged “Angles & constructions: basics”; that is a separate bank/KP bug). Rewriting Results snapshots already shown in the current session. Changing options JSON. New UI.

## 2. Context for agents (non-negotiables)

- Stack: Vite React (`frontend/`), Express + Neon (`backend/`), FastAPI agents (`agents/`).
- Seeded `knowledge_points` drive generation; do not invent KP ids in prompts.
- Secrets stay in `.env.local`; never commit API keys or student PII dumps.
- Security / PII / live question-bank auto-correction: humans decide.
- This slice does **not** invent a new bank-edit path. It only rescores history after an existing apply path (`applyProposedFix`: auto-apply or review Accept) has already written `questions`.
- Rescore **all** users who answered that `question_id`, not only the feedback author. The bank is global.
- Reuse `answersMatch` / `normalizeAnswerText` from `backend/lib/userFeedbackTriage.js`. Do not introduce a second matcher.

## 3. Acceptance criteria (testable)

1. **AC-1** — Given `history` rows for a question whose stored `correct` is false and `given_answer` matches the current `answer_cn` or `answer_en`, When `rescoreHistoryForQuestion` runs, Then those rows have `correct = true`.
2. **AC-2** — Given `history` rows whose `given_answer` does not match the current bank answers, When rescore runs, Then those rows have `correct = false` (including a student who was marked correct against the previous wrong bank answer).
3. **AC-3** — Given `applyProposedFix` writes `answer_cn` and/or `answer_en`, When that function returns, Then `rescoreHistoryForQuestion` has been called for that `question_id` (covers auto-apply and review Accept; both already call `applyProposedFix`).
4. **AC-4** — Given existing applied feedback (including Q2345), When the backfill script runs, Then history for those question ids is rescored against the current bank answers. Explanation-only applies (no answer field change) must not flip correctness.

## 4. Open questions

| # | Question | Answer (who / when) |
|---|----------|---------------------|
| 1 | Live recompute on `/api/history/full` as a display safety net, or persist-only? | **Persist-only.** KP scores and diagnostic focus KPs read `history.correct` in SQL; a display-only patch would leave scores stale. |
| 2 | Fix Q2345’s wrong KP (“Angles & constructions: basics” on a fractions item)? | **Out of this FS.** CAE apply never writes `knowledge_point_id`. Follow-up if desired. |

## 5. Agent-executable engineering instructions

### Approach

1. Add `historyAnswerIsCorrect(given, answerCn, answerEn)` wrapping `answersMatch` against both language answers.
2. Add `rescoreHistoryForQuestion(pool, questionId)`: load current `answer_cn`/`answer_en`; load history rows for that id; `UPDATE history SET correct = $1 WHERE id` / or bulk update per row. Return `{ updated, correctTrue, correctFalse }`.
3. Call it from `applyProposedFix` **after** the `UPDATE questions`, only when at least one of `answer_cn` / `answer_en` was written. Content/explanation-only applies skip rescore.
4. Add `backend/scripts/rescore_history_from_bank.js`: for each distinct `history.question_id` (or optionally `--question-id 2345`), call `rescoreHistoryForQuestion`. Safe to re-run.
5. Unit-test the matcher + a mocked-pool rescore (or extract pure `computeHistoryCorrectFlag` and test that plus “skip when no answer fields”).

### Files / areas

| Path / area | Change |
|-------------|--------|
| `backend/lib/userFeedbackTriage.js` | `historyAnswerIsCorrect`, `rescoreHistoryForQuestion`; call from `applyProposedFix`; export both |
| `backend/test/userFeedbackTriage.test.js` | AC-1 / AC-2 / skip-when-no-answer |
| `backend/scripts/rescore_history_from_bank.js` | Backfill CLI |

### API / UI contracts

| Surface | Behavior |
|---------|----------|
| History page `/api/history/full` | Unchanged query; reads updated `h.correct`. After rescore, Q2345 with given `3/4` and bank `3/4` shows Correct. |
| `/api/scores/knowledge-points` | Unchanged SQL; counts update because `h.correct` changed. |
| Feedback review UI | No change. |

### Data model

- Tables / columns: `history.correct` (existing BOOLEAN). No new columns.
- Migration / ensureTables: `none`
- Rollback: re-run rescore is idempotent; no schema rollback.

### Error / result shape

- Rescore failure after a successful question update must be logged and must **not** roll back the question apply (bank fix is the source of truth). Script / decide response may include `history_rescored` counts when cheap; not required for UI.

## 6. Quality constraints

- Idempotent: running rescore twice on the same question yields the same flags.
- Do not load real student PII into tests; use synthetic `given_answer` strings (`3/4`, `2/3`).
- Keep rescore in the apply path so future Accepts do not need a script.

## 7. AC → verification map

| AC | Check (automated test name or manual steps) | Result |
|----|-----------------------------------------------|--------|
| AC-1 | `historyAnswerIsCorrect('3/4','3/4','3/4') === true`; mocked rescore sets `correct=true` | **pass** |
| AC-2 | given `2/3` vs bank `3/4` → false; previously-true row flips to false | **pass** |
| AC-3 | `applyProposedFix` with answer fields invokes rescore; explanation-only does not | **pass** |
| AC-4 | `node scripts/rescore_history_from_bank.js --question-id 2345` then History for that item is Correct | **pass** (DB: Q2345 `updated: 1`, `correctTrue: 1`) |

## 8. Test plan

- Unit: matcher + rescore skip/apply behavior (`backend/test/userFeedbackTriage.test.js`).
- Manual after deploy: History for Q2345 (2026-09-19 10:25) shows Correct; KP scores for that KP no longer count it as a miss **unless** the KP id itself is still the angles KP (see §4 #2).

## 9. Definition of Done

- [x] FS was **Ready** before coding started
- [x] All ACs verified (§7)
- [x] **As-built** filled after implementation
- [x] Diff scoped to this FS
- [x] Status set to **Done** (or Follow-ups listed)
- [x] No secrets in the diff

## 10. As-built (fill after code)

**What shipped:**
- `historyAnswerIsCorrect` + `rescoreHistoryForQuestion` in `backend/lib/userFeedbackTriage.js`
- `applyProposedFix` rescored `history.correct` after writing `answer_cn` / `answer_en`; explanation-only applies skip rescore; rescore errors are logged and do not roll back the question update
- `backend/scripts/rescore_history_from_bank.js` for already-applied rows (`--question-id` or all distinct history question ids)
- Tests in `backend/test/userFeedbackTriage.test.js`

**How to run / verify:**
```powershell
cd backend
npx vitest run test/userFeedbackTriage.test.js
node scripts/rescore_history_from_bank.js --question-id 2345
# optional full backfill:
node scripts/rescore_history_from_bank.js
```
Then refresh History: Q2345 with given `3/4` should show Correct.

**Known limits / deltas vs plan:**
- Q2345’s KP remains “Angles & constructions: basics” (out of scope).
- Full backfill also flipped 6 other stale questions (861, 1068, 1340, 1595, 2186, 2249); Q2345 was already updated by the targeted run.

## 11. Evidence notes (fill after code / PR)

- Commands run:
  - `cd backend; npx vitest run test/userFeedbackTriage.test.js` → 12 passed
  - `cd backend; npm test` → 14 passed (2 files)
  - `node scripts/rescore_history_from_bank.js --question-id 2345` → `updated: 1, correctTrue: 1`
  - `node scripts/rescore_history_from_bank.js` → `questions: 1722, updated: 6, correctTrue: 1409, correctFalse: 334`
- Output / CI link: local only this session; not committed/pushed
- Review notes: persist-only as specified; no History UI change.

## 12. Follow-ups (each needs its own FS later)

- Re-tag Q2345 (and similar) off “Angles & constructions: basics” onto a fractions KP; CAE apply still cannot change `knowledge_point_id`.
- Optional: live SQL/JS correctness on scores queries as a second safety net if any non-apply path edits `questions.answer_*`.
