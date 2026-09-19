# Feature Spec — Draw question charts with Chart.js

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20260919-question-charts-chartjs |
| **PR** | — |
| **Title** | Render bar / pie / line charts on the frontend from question chart data (Chart.js) |
| **Feature Key** | UI, Diagnostic, Agent |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-09-19; `specs/stories/20260919-question-charts-po.md` |
| **Packages** | frontend, backend, agents |
| **Created** | 2026-09-19 |
| **Ready** | 2026-09-19 (human: ready) |
| **Implemented** | 2026-09-19 |

## 1. Intent

**Problem:** Knowledge points such as “Tables & charts” produce stems like “Look at a bar chart showing sales: Monday 30, Tuesday 45, Wednesday 40”, but the UI only prints text. `lesson.images` is always `[]`. The diagnostic prompt currently forbids pictures, so the model never emits a drawable spec. Live bank sample: ~14 chart-ish questions; none have a renderable figure.

**Outcome:** When a question has a labeled numeric series, Chart.js draws a bar, pie, or line chart on diagnostic, results, and history. Conceptual chart questions (no series) stay text-only. New generations put the series in `metadata.chart` so the client does not have to guess.

**In scope:** Chart.js (MIT) on the frontend; `parseQuestionChart`; pass `metadata` through history and by-ids APIs; prompt + agents prompt to emit `metadata.chart` for data-display items.

**Out of scope:** Geometry / shape pictures; bar-model / tape diagrams; photos or DALL·E; storing PNG/SVG in the database; rewriting existing `questions` rows; mermaid; Chart.js on the feedback review page.

## 2. Context for agents (non-negotiables)

- Stack: Vite React (`frontend/`), Express + Neon (`backend/`), FastAPI agents (`agents/`).
- Seeded `knowledge_points` drive generation; do not invent KP ids in prompts.
- Secrets stay in `.env.local`; never commit API keys or student PII dumps.
- Security / PII / live question-bank auto-correction: humans decide.
- Chart.js is MIT (allowed). Do not add copyleft chart libraries.
- Do **not** invent chart data. If labels and values cannot be read from `metadata.chart` or from the stem, render no chart.
- Keep geometry rule: shape identification stays text properties, not pictures. Charts are the exception for data-display KPs.

## 3. Acceptance criteria (testable)

1. **AC-1** — Given a question with `metadata.chart = { type:"bar", labels:["Monday","Tuesday","Wednesday"], values:[30,45,40] }` (or the same series written in the stem), When diagnostic / results / history renders that item, Then a Chart.js bar chart with those three values is visible.
2. **AC-2** — Given a conceptual stem such as “In a bar chart, what does the length of the bar represent?” with no labeled series, When it renders, Then no chart canvas is mounted.
3. **AC-3** — Given `parseQuestionChart`, When input is a pie/line spec or a stem containing “pie chart” / “line graph” plus `Name number` pairs, Then `kind` is `pie` or `line` respectively and `labels.length === values.length >= 2`.
4. **AC-4** — Given a new diagnostic generation, When the question is a specific data chart (not a definition), Then the prompt requires `metadata.chart` with `type`, `labels`, `values`. Existing bank rows are not bulk-updated; they use the stem parser when possible.

## 4. Open questions

| # | Question | Answer (who / when) |
|---|----------|---------------------|
| 1 | Draw a generic sample chart for definition questions? | **No.** Inventing data would mislead. |
| 2 | Geometry figures this slice? | **No.** Follow-up FS. |
| 3 | Backfill `metadata.chart` onto the ~14 existing chart-ish rows? | **No this FS.** Parser covers the labeled ones (e.g. Q2292). |

## 5. Agent-executable engineering instructions

### Approach

1. Add `frontend/src/parseQuestionChart.ts`:
   - Valid spec: `kind` in `bar|pie|line`, `labels` string[], `values` finite numbers, same length, length >= 2, optional `title`.
   - Prefer `question.metadata.chart` (`type` alias of `kind`).
   - Else detect kind from `content_en` / `content_cn` (bar chart / bar graph / 柱状/条形图; pie / 饼图; line graph/chart / 折线).
   - Else extract `Label number` pairs from the stem (English `Monday 30` / `Anna 5` and Chinese `周一 30` / `安娜 5`). Reject if fewer than 2 pairs.
   - Return `null` when kind is missing or pairs cannot be aligned.
2. Add `frontend/src/QuestionChart.tsx`: canvas + Chart.js v4; destroy on unmount / spec change; height ~220px; no animation required.
3. Mount under the stem on `App.tsx` (diagnostic), `Results.tsx`, `HistoryPage.tsx`.
4. Backend: include `q.metadata` on `GET /api/history/full` and `GET /api/questions/by-ids`. Results already loads by-ids; add `metadata` to the mapped row.
5. Prompts (`backend/lib/prompts.js` and `agents/app/prompts/diagnostic.py`):
   - Keep “no photos / no geometry pictures”.
   - Add: if the item refers to a specific bar/pie/line data display, include `metadata.chart` and write the same labels/values in the stem. Frontend draws it. Do not say “look at the chart” without `metadata.chart`.
6. `npm install chart.js` in `frontend/` (verify MIT at install time). No `react-chartjs-2` unless it is clearly simpler; a small canvas wrapper is enough.

### Files / areas

| Path / area | Change |
|-------------|--------|
| `frontend/src/parseQuestionChart.ts` | New parser |
| `frontend/src/parseQuestionChart.test.ts` | AC-1/2/3 unit tests |
| `frontend/src/QuestionChart.tsx` | Chart.js wrapper |
| `frontend/src/App.tsx` | Diagnostic mount |
| `frontend/src/Results.tsx` | Results mount + metadata from by-ids |
| `frontend/src/HistoryPage.tsx` | History mount |
| `frontend/package.json` | `chart.js` |
| `backend/index.js` | history/full + questions/by-ids return metadata |
| `backend/lib/prompts.js` | `metadata.chart` rule |
| `agents/app/prompts/diagnostic.py` | Same rule |

### API / UI contracts

| Surface | Behavior |
|---------|----------|
| Question object | May include `metadata.chart`: `{ "type": "bar"\|"pie"\|"line", "labels": string[], "values": number[], "title"?: string }` |
| `GET /api/history/full` | Adds `metadata` JSON on each row |
| `GET /api/questions/by-ids` | Includes `metadata` (already `SELECT *` is OK if present; frontend must keep the field) |
| Diagnostic / Results / History | Chart under stem when parser returns a spec; otherwise unchanged |

### Data model

- Tables / columns: `questions.metadata` JSON (existing). No new column.
- Migration / ensureTables: `none`
- Rollback: omit chart in UI if `metadata.chart` missing; parser no-ops.

### Error / result shape

- Invalid chart spec → no chart, no crash.
- Chart.js canvas failure → catch, hide chart, keep stem.

## 6. Quality constraints

- Charts are decorative-for-data: include a short text fallback of `labels: values` in `aria-label` for screen readers / TTS can keep reading the stem.
- Do not change scoring.
- i18n: axis labels come from the current language stem or from `metadata.chart.labels` (English in metadata is OK; stem parser uses the displayed language text).
- Keep Chart.js bundle to the three controllers actually used (bar, pie, line, category scale, linear scale, legend).

## 7. AC → verification map

| AC | Check (automated test name or manual steps) | Result |
|----|-----------------------------------------------|--------|
| AC-1 | `parseQuestionChart` on metadata.chart and on Q2292-style stem; manual diagnostic render | **pass** (unit); manual after deploy |
| AC-2 | `parseQuestionChart` on Q2354-style definition stem → `null` | **pass** |
| AC-3 | pie + line fixtures in the same test file | **pass** |
| AC-4 | Prompt files contain `metadata.chart`; no bank UPDATE in this slice | **pass** |

## 8. Test plan

- Unit: `frontend` vitest `parseQuestionChart.test.ts` (no real canvas required).
- Manual after deploy: generate or open a Tables & charts item with labeled data; confirm bar appears on the question card, results, and history.

## 9. Definition of Done

- [x] FS was **Ready** before coding started
- [x] All ACs verified (§7)
- [x] **As-built** filled after implementation
- [x] Diff scoped to this FS
- [x] Status set to **Done** (or Follow-ups listed)
- [x] No secrets in the diff

## 10. As-built (fill after code)

**What shipped:**
- `frontend/src/parseQuestionChart.ts` prefers `metadata.chart`, else parses labeled series from the stem
- `frontend/src/QuestionChart.tsx` draws bar/pie/line with Chart.js v4 (MIT); invalid/missing spec mounts nothing
- Diagnostic (`App.tsx`), Results, History show the chart under the stem
- `GET /api/history/full` and `GET /api/questions/by-ids` return `metadata`
- Generator prompts (Express + agents) require `metadata.chart` for specific data charts; geometry stays text-only

**How to run / verify:**
```powershell
cd frontend
npx vitest run src/parseQuestionChart.test.ts
npm run build
```
Then open a Tables & charts item with labeled data (e.g. “Monday 30, Tuesday 45”) on diagnostic / results / history.

**Known limits / deltas vs plan:**
- Existing unlabeled lists (“5, 8, 12, 7”) still have no chart (do not invent labels).
- `Diagnostic.test.tsx` was already failing without a Router; not part of this slice.
- Bundle grew with Chart.js (frontend production JS ~508 kB).

## 11. Evidence notes (fill after code / PR)

- Commands run:
  - `npx vitest run src/parseQuestionChart.test.ts` → 5 passed
  - `npx tsc --noEmit` → exit 0
  - `npm run build` → vite built in 2.06s
  - Chart.js `LICENSE.md` is MIT
- Output / CI link: local this session; not pushed
- Review notes: no `questions` row rewrites; AC-4 prompt grep shows `metadata.chart` in `backend/lib/prompts.js` and `agents/app/prompts/diagnostic.py`.

## 12. Follow-ups (each needs its own FS later)

- Geometry / figure drawing (not Chart.js).
- Optional one-shot backfill of `metadata.chart` onto existing labeled chart questions.
- Number-bond / bar-model diagrams for Singapore-style word problems.
