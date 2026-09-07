# Feature Spec — User feedback Phase 1 (Results → store → prompt)

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20260907-user-feedback-phase1 |
| **PR** | — |
| **Title** | Results Feedback button; persist user_question_feedback; inject user_reports |
| **Feature Key** | Feedback, UI, Diagnostic |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-09-07 |
| **Packages** | frontend, backend, agents |
| **Created** | 2026-09-07 |
| **Ready** | 2026-09-07 (proceed to commit/deploy) |
| **Implemented** | 2026-09-07 |

## 1. Intent

**Problem:** Parents cannot report wrong answers/explanations after a diagnostic.  
**Outcome:** Free-text feedback is stored and included in the next diagnostic `feedback_context.user_reports`; questions are not auto-rewritten.  
**In scope:** Results UI, API, table, prompt injection.  
**Out of scope:** Auto-correct answers (Phase 2); admin review UI; new agent.

## 3. Acceptance criteria

1. **AC-1** — Given Results, When Feedback is submitted with text, Then API returns ok and a `user_question_feedback` row exists.
2. **AC-2** — Given open user feedback for related grade/subject/KP, When diagnostic builds prompt context, Then `user_reports` is present.
3. **AC-3** — Given feedback submit, When insert runs, Then `questions.answer_*` / `explanation_*` are not updated in that path.

## 7. AC → verification map

| AC | Check | Result |
|----|-------|--------|
| AC-1 | Code path + post-deploy manual | pass (code); manual after deploy |
| AC-2 | `getFeedbackContext` includes `user_reports` | pass (code) |
| AC-3 | `insertUserQuestionFeedback` only INSERTs feedback table | pass (code review) |

## 10. As-built

- `frontend/src/Results.tsx` — Feedback button + modal  
- `POST /api/user-feedback` in `backend/index.js`  
- `user_question_feedback` via `feedbackStore.js`  
- Prompt + `loadFeedbackContextForPrompt` → `user_reports`  
- Table created on backend boot (`ensureUserQuestionFeedbackTable`)

## 11. Evidence

- Shipped via commit/deploy 2026-09-07 (Phase 1 only; no answer auto-fix).
