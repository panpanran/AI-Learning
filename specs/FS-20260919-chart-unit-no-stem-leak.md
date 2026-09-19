# Feature Spec — Chart unit on axis; do not leak unit in the stem

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20260919-chart-unit-no-stem-leak |
| **PR** | — |
| **Title** | Unit questions: axis shows mm; English stem must not say millimeters |
| **Feature Key** | UI, Diagnostic |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-09-19 (rainfall unit Q; EN stem leaks answer; chart has no unit) |
| **Packages** | frontend, backend, agents |
| **Created** | 2026-09-19 |
| **Ready** | 2026-09-19 (human: 英文直接说答案不对；条状图里没有单位) |
| **Implemented** | 2026-09-19 |

## 1. Intent

**Problem:** Chinese stem is “条形图显示每月降雨量，单位是什么？” (no unit). English is “Which unit is used in a bar chart showing monthly rainfall **in millimeters**?”, which is the answer. The Chart.js figure has no Y-axis unit, so it is not a readable rainfall chart.

**Outcome:** Displayed English matches the Chinese intent (ask the unit, do not name it). The bar chart Y-axis shows `mm` / `毫米`. New generation must put the unit on `metadata.chart.yLabel` / the figure, never in the unit-question stem. One bank row is corrected.

**In scope:** `yLabel` on chart spec; strip leaked “in millimeters” at display; prompt line; UPDATE the rainfall-unit `content_en` if it still contains the answer.

**Out of scope:** Geometry; changing options; other KPs.

## 2. Context for agents (non-negotiables)

- Stack: Vite React (`frontend/`), Express + Neon (`backend/`), FastAPI agents (`agents/`).
- Seeded `knowledge_points` drive generation; do not invent KP ids in prompts.
- Secrets stay in `.env.local`; never commit API keys or student PII dumps.
- Security / PII / live question-bank auto-correction: humans decide.

## 3. Acceptance criteria (testable)

1. **AC-1** — Given EN stem “…rainfall **in millimeters**?” and answer Millimeters, When `stripLeakedUnitFromStem` runs, Then the displayed stem does not contain `millimeter`.
2. **AC-2** — Given that rainfall unit question, When `parseQuestionChart` runs, Then `yLabel` is `mm` (en) or `毫米` (zh).
3. **AC-3** — Given a bar Chart.js spec with `yLabel`, When the chart is configured, Then the Y scale title is that label.
4. **AC-4** — Generator prompts say: if asking which unit, put the unit on the chart axis, not in `content_en` / `content_cn`.

## 4. Open questions

| # | Question | Answer (who / when) |
|---|----------|---------------------|
| 1 | Bulk-fix other unit-leak stems? | This FS: rainfall Q2324 + display-time strip. Other rows get the strip if they match the same pattern. |

## 5. Agent-executable engineering instructions

### Approach

1. Add `yLabel` to `QuestionChartSpec`; infer `mm` / `毫米` for rainfall (or short unit from the answer on unit questions).
2. Strip `in millimeters` (and the answer unit) from unit-question stems at display time; case-insensitive “which unit”.
3. Chart.js Y scale `title.display` when `yLabel` is set.
4. Prompt: unit goes on `metadata.chart.yLabel`, never in a which-unit stem.
5. UPDATE live `questions.content_en` for the rainfall item.

### Files / areas

| Path / area | Change |
|-------------|--------|
| `frontend/src/parseQuestionChart.ts` | `yLabel`, strip helper, infer mm for rainfall |
| `frontend/src/parseQuestionChart.test.ts` | AC-1, AC-2 |
| `frontend/src/QuestionChart.tsx` | Y-axis title |
| `frontend/src/App.tsx`, `HistoryPage.tsx`, `Results.tsx` | Display stripped stem |
| `backend/lib/prompts.js`, `agents/app/prompts/diagnostic.py` | No unit leak in stem |
| Live `questions.content_en` | One UPDATE for Q2324 |

### Data model

- Tables / columns: `questions.content_en` (existing); no schema change
- Migration: none
- Rollback: restore the previous English stem if needed

## 6. Quality constraints

- Display strip must not rewrite non-unit questions.
- Axis unit is the pedagogical answer location; the stem asks.

## 7. AC → verification map

| AC | Check | Result |
|----|-------|--------|
| AC-1 | `strips leaked unit from English rainfall stem (AC-1)` | pass |
| AC-2 | `puts mm on the Y axis for rainfall unit questions (AC-2)` | pass |
| AC-3 | `QuestionChart.tsx` `scales.y.title` when `parsed.yLabel` | pass (code) |
| AC-4 | prompts.js + diagnostic.py contain yLabel / no stem leak | pass (grep) |

## 8. Test plan

- Unit: `npx vitest run src/parseQuestionChart.test.ts` from `frontend/`
- Build: `npm run build` from `frontend/`
- Live: UPDATE Q2324 `content_en`; refresh History/diagnostic after frontend deploy

## 9. Definition of Done

- [x] FS was **Ready** before coding started
- [x] All ACs verified (§7)
- [x] **As-built** filled after implementation
- [x] Diff scoped to this FS
- [x] Status set to **Done** (or Follow-ups listed)
- [x] No secrets in the diff

## 10. As-built (fill after code)

**What shipped:**
- `stripLeakedUnitFromStem` / `displayQuestionStem` hide leaked units on diagnostic, results, history
- `parseQuestionChart` sets `yLabel` (`mm` / `毫米` for rainfall)
- Chart.js Y-axis title plus tooltip suffix
- Generator prompts: unit on `yLabel`, never in the which-unit stem
- Live bank Q2324 `content_en` → `Which unit is used in a bar chart showing monthly rainfall?`

**How to run / verify:**
```powershell
cd frontend
npx vitest run src/parseQuestionChart.test.ts
npm run build
```
Refresh History after this frontend is deployed: English stem has no millimeters; Y axis shows `mm` / `毫米`.

**Known limits / deltas vs plan:**
- Axis title is not covered by a DOM test (canvas). Parser test covers `yLabel`; QuestionChart wires it.
- Frontend must be deployed before production History shows the Y-axis unit. Bank English is already updated.

## 11. Evidence notes (fill after code / PR)

- Commands run:
  - `cd frontend; npx vitest run src/parseQuestionChart.test.ts` → 9 passed
  - `cd frontend; npm run build` → built in 969ms
  - one-shot UPDATE `questions` where `content_en ILIKE '%bar chart showing monthly rainfall in millimeters%'` → `updated 1`, id 2324
- Output / CI link: local only this session; not committed/pushed
- Review notes: display strip is case-insensitive (`Which unit`); works even if `answer` is empty.

## 12. Follow-ups (each needs its own FS later)

- Optional audit of other English stems that embed the unit answer (`in centimeters`, `in litres`, …).
