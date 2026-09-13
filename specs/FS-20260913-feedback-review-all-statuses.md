# Feature Spec — Feedback review: all statuses + filter

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20260913-feedback-review-all-statuses |
| **PR** | — |
| **Title** | Feedback review lists all statuses with client filter (newest first) |
| **Feature Key** | Feedback, UI |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-09-13 |
| **Packages** | frontend, backend |
| **Created** | 2026-09-13 |
| **Ready** | 2026-09-13 |
| **Implemented** | 2026-09-13 |

## 1. Intent

**Problem:** Review UI only showed `open`/`acknowledged`, so `dismissed`/`applied` were invisible.  
**Outcome:** List all own feedback newest-first; filter by status; Re-analyze can reopen finalized rows.

## 3. Acceptance criteria

1. **AC-1** — GET with `status=all` (default) returns all own rows by `created_at` DESC.
2. **AC-2** — `/feedback` status chips filter the list.
3. **AC-3** — Re-analyze on dismissed/applied resets to open and re-runs triage.

## 7. AC map

| AC | Check | Result |
|----|-------|--------|
| AC-1 | `listUserFeedback` status=all | **pass** |
| AC-2 | FeedbackReview filter chips | **pass** |
| AC-3 | reanalyze route removes finalized block | **pass** |

## 10. As-built

- Default list `status=all`; UI chips All/open/acknowledged/applied/dismissed.
- Also fixed bank Q2249: answer **1100** (548→500, 639→600); feedback id=2 marked applied (AI had wrongly dismissed; explanation had claimed 639→700).
- **2026-09-13 UX:** Accept disabled when already `applied` (with on-screen hint). Human **Re-analyze** forces `autoApply=false` so the row lands in `acknowledged` for Accept instead of silently re-applying.

## 11. Evidence

- DB update script for Q2249 + feedback #2 run in this session.
- Code changes in list/reanalyze/FeedbackReview/i18n.
