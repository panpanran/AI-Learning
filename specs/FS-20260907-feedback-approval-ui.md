# Feature Spec — Feedback approval UI (handle acknowledged)

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20260907-feedback-approval-ui |
| **PR** | — |
| **Title** | Human review UI for acknowledged feedback (Accept / Reject / Re-analyze) |
| **Feature Key** | Feedback, UI |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-09-07 |
| **Packages** | frontend, backend, agents (stub) |
| **Created** | 2026-09-07 |
| **Ready** | 2026-09-07 |
| **Implemented** | 2026-09-07 |

## 1. Intent

**Problem:** `acknowledged` rows sit in DB with `proposed_fix` but parents cannot approve/reject; no review UI.  
**Outcome:** Logged-in user can open `/feedback`, see pending items (own feedback), Accept (apply CAE fields), Reject (dismiss), or Re-analyze (queue triage again).  
**In scope:** List + decide APIs; Feedback review page; nav entry; SPA route; thin agents `/v1/feedback/triage` stub that Express can call later (optional prefer local triage).  
**Out of scope:** Full LangGraph checkpoint; multi-user admin roles; changing options.

## 3. Acceptance criteria

1. **AC-1** — Given acknowledged feedback for the user, When GET `/api/user-feedback?status=acknowledged`, Then items include question snapshot + proposed_fix.
2. **AC-2** — Given Accept on an item with proposed CAE fields, When decide runs, Then `questions` content/answer/explanation update and status=`applied`.
3. **AC-3** — Given Reject, When decide runs, Then status=`dismissed` and questions unchanged.
4. **AC-4** — Given `/feedback` page, When opened while logged in, Then pending list renders with Accept/Reject/Re-analyze actions.

## 5. Files

| Path | Change |
|------|--------|
| `backend/lib/userFeedbackTriage.js` | `decideUserFeedback`, `listUserFeedback`, export `applyProposedFix` |
| `backend/index.js` | GET list, POST decide, POST reanalyze |
| `frontend/src/FeedbackReview.tsx` | New page |
| `frontend/src/main.tsx` + vite SPA routes | `/feedback` |
| `frontend/src/i18n.ts` + nav (App/History/Scores/Results/MenuBar) | strings + entry |
| `agents/app` | `POST /v1/feedback/triage` stub |

## 6. As-built

- List defaults to `acknowledged,open`; ownership via JWT + username-merged user ids.
- Accept applies only CAE fields from `proposed_fix`; Reject → `dismissed`; Re-analyze resets to `open` and awaits `triageUserFeedbackById`.
- Agents endpoint returns `not_implemented` (Express remains triage engine).

## 7. AC map

| AC | Check | Result |
|----|-------|--------|
| AC-1 | Code: `listUserFeedback` + GET route | pass |
| AC-2 | Code: `decideUserFeedback` accept path | pass |
| AC-3 | Code: reject → dismissed | pass |
| AC-4 | Code: `FeedbackReview` + `/feedback` route + nav | pass |

## 8. Evidence

- Local: module load of `userFeedbackTriage` exports; routes wired in `index.js`.
- Manual: open `/feedback` after deploy; Accept/Reject on an `acknowledged` row.
