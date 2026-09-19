# Feature Spec — Illustrative chart when the stem has no series

| Field | Value |
|-------|--------|
| **FS-ID** | FS-20260919-illustrative-chart-fallback |
| **PR** | — |
| **Title** | Conceptual bar/pie/line questions get a seeded example Chart.js figure |
| **Feature Key** | UI, Diagnostic |
| **Status** | Done |
| **Owner** | Ran Pan |
| **PO / story refs** | chat 2026-09-19 (“随机画数字，反正也不是问的数字，只要有图就行了”) |
| **Packages** | frontend |
| **Created** | 2026-09-19 |
| **Ready** | 2026-09-19 (human: random numbers OK for unit/definition chart stems) |
| **Implemented** | 2026-09-19 |

## 1. Intent

**Problem:** History items like “Which unit is used in a bar chart showing monthly rainfall in millimeters?” mention a chart but have no labels/values, so the current parser draws nothing.

**Outcome:** If the stem names exactly one of bar / pie / line, refers to a **specific scene** (e.g. monthly rainfall) and has no series, Chart.js shows a small **example** chart. Pure meaning questions (“what does the length of the bar represent?”) stay text-only. Values are seeded from the stem. A caption states the numbers are not part of the question. Scoring is unchanged.

**In scope:** `parseQuestionChart` fallback + caption on `QuestionChart`. Tests.

**Out of scope:** LLM-generated realistic data; rewriting `questions` rows; geometry figures; changing which-type questions that name two or more chart kinds.

## 2. Context for agents (non-negotiables)

- Stack: Vite React (`frontend/`), Express + Neon (`backend/`), FastAPI agents (`agents/`).
- Do not invent data when the stem already has a series (labeled pairs or two-plus bare numbers). Those stay on the existing parser path.
- Example values must not be used for scoring or answer matching.

## 3. Acceptance criteria (testable)

1. **AC-1** — Given the rainfall-unit stem (“bar chart showing monthly rainfall in millimeters”) with no series, When `parseQuestionChart` runs, Then it returns `kind: "bar"`, `illustrative: true`, at least 2 labels/values, and a second call with the same stem returns the same values.
2. **AC-2** — Given a stem that names bar, pie, and line as options (which-type), When parse runs, Then the result is `null` (do not pick a random kind).
3. **AC-3** — Given a bar stem with an unlabeled list `5, 8, 12, 7` that the question asks about, When parse runs, Then it does **not** replace those numbers with a different random series (still `null`, same as FS-20260919-question-charts-chartjs).
4. **AC-4** — Given an illustrative spec, When `QuestionChart` renders, Then a caption says the figure is an example / 示意图 and numbers are not part of the question.
5. **AC-5** — Given “In a bar chart, what does the length of the bar represent?”, When parse runs, Then the result is `null`.

## 4. Open questions

| # | Question | Answer (who / when) |
|---|----------|---------------------|
| 1 | True `Math.random()` each paint? | **No.** Seed from the stem so History does not flicker. |

## 5. Agent-executable engineering instructions

### Approach

1. Extend `QuestionChartSpec` with `illustrative?: boolean`.
2. After metadata + labeled-pair paths fail: if exactly one chart kind is in the stem and there are fewer than 2 bare numbers, build 4 seeded values (range 3–12) and generic labels (`Jan`–`Apr` / `1月`–`4月` when the stem mentions month/rainfall/月/降雨, else `A`–`D`).
3. `QuestionChart`: if `illustrative`, show muted caption under the canvas (en/zh from `title` or a `caption` field set by the parser using `lang`).
4. Update tests; flip the old “conceptual stem → null” case to AC-1 behavior.

### Files / areas

| Path / area | Change |
|-------------|--------|
| `frontend/src/parseQuestionChart.ts` | Illustrative fallback |
| `frontend/src/parseQuestionChart.test.ts` | AC-1…3 |
| `frontend/src/QuestionChart.tsx` | Caption |

### Data model

- Tables / columns: `none`

## 7. AC → verification map

| AC | Check | Result |
|----|-------|--------|
| AC-1 | unit: rainfall stem illustrative + stable | **pass** |
| AC-2 | unit: bar/pie/line which-type → null | **pass** |
| AC-3 | unit: unlabeled 5,8,12,7 → null | **pass** |
| AC-4 | caption rendered when `illustrative` (code + unit if cheap) | **pass** (caption on spec + QuestionChart) |
| AC-5 | “length of the bar represent” → null | **pass** |

## 9. Definition of Done

- [x] Ready before code
- [x] ACs verified
- [x] As-built filled
- [x] Status Done

## 10. As-built

**What shipped:** Conceptual bar/pie/line stems with no series get a 4-bar (or pie/line) Chart.js example. Values are hashed from the stem so History does not flicker. Caption: “Example chart; numbers are not part of the question”. Which-type stems and unlabeled number lists are unchanged.

**How to run:** `cd frontend; npx vitest run src/parseQuestionChart.test.ts`

**Known limits:** Example rainfall uses Jan–Apr, not real climate data.

## 11. Evidence notes

- `npx vitest run src/parseQuestionChart.test.ts` → 6 passed

## 12. Follow-ups

- Optional: use unlabeled number lists as bar heights with Category 1..n instead of leaving them blank.
