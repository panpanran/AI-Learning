# Feature Spec — AI feedback apply (content / answer / explanation only)

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20260907-feedback-ai-apply-cae |
| **PR** | — |
| **Title** | AI triage may rewrite question content, answer, and explanation only |
| **Feature Key** | Feedback, Diagnostic, Eval |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-09-07 |
| **Packages** | backend |
| **Created** | 2026-09-07 |
| **Ready** | 2026-09-07 |
| **Implemented** | 2026-09-07 |

## 1. Intent

**Problem:** `acknowledged` feedback only warns the next generator; the bad bank item stays wrong. Parent wants AI to decide and fix the item.  
**Outcome:** After feedback, AI analyzes and may update **only** `content_*`, `answer_*`, and `explanation_*` (CN+EN). Options / KP / metadata are not rewritten in this slice.  
**In scope:** Expand triage LLM schema + apply path; confidence + option-consistency gates; re-triage open/acknowledged via script.  
**Out of scope:** Changing `options` JSON; UI approve button; deleting questions.

## 3. Acceptance criteria

1. **AC-1** — Given feedback on a question, When triage LLM runs, Then `proposed_fix` may include `content_cn/en`, `answer_cn/en`, `explanation_cn/en` (and reason/confidence).
2. **AC-2** — Given LLM confidence ≥ 0.75, `dismiss=false`, and proposed answers match an existing option (each language when bilingual options exist), When auto-apply is enabled, Then those three field groups are written to `questions` and feedback `status=applied`.
3. **AC-3** — Given low confidence, dismiss, or answer not in options, When triage finishes, Then `questions` is unchanged and status is `acknowledged` or `dismissed`.
4. **AC-4** — Given math metadata with verifiable nums, When bank answer is wrong, Then deterministic math still wins for `answer_*` (explanations/content may still come from LLM).
5. **AC-5** (fix 2026-10-05, user bug report in chat) — Given answers that differ only by a numeric continuation (bank `50`, given `500`; `3` vs `3/4`), When the answer matcher runs (Node `answersMatch` / `findMatchingOption`, Python `answers_match` / `find_matching_option`, frontend `optionMatchesGiven`), Then they do not match. Prefix / substring matches count only at a numeric boundary (`500个` still matches `500`). Previously feedback Q2666 was dismissed as "Bank answer already matches the given answer" and Accept would have picked option `5`.

## 7. AC → verification map

| AC | Check | Result |
|----|-------|--------|
| AC-1 | LLM schema includes CAE fields | **pass** |
| AC-2 | Unit gates + backfill applied feedback_id=1 via llm conf 0.95 | **pass** |
| AC-3 | Unit: answer not in options / low conf rejected | **pass** |
| AC-4 | Math helpers unchanged | **pass** |
| AC-5 | vitest "does not treat a numeric prefix as the same number", "picks the exact place-value option"; Python `test_answers_match_rejects_numeric_prefix` | **pass** |

## 10. As-built

- `userFeedbackTriage.js`: LLM may propose content/answer/explanation; apply when conf ≥ `USER_FEEDBACK_APPLY_MIN_CONFIDENCE` (default 0.75) and answers ∈ options.
- Script: `--include-acknowledged` re-runs acknowledged rows.
- Does **not** modify `options`.

## 11. Evidence

- vitest CAE + math suites
- `triage_open_user_feedback.js --include-acknowledged` → `applied` feedback_id 1 / question_id 2186
- 2026-10-05 AC-5: `backend> npm test` 27/27 pass; Python matcher asserts run via `python -c` (pytest not installed locally, so the pytest file itself was not executed); `frontend> npm run build` built. `tsc --noEmit` reports one existing error in `QuestionChart.tsx`, unrelated and unchanged.
