# PO story — Render charts inside questions

**Title:** Student can see the bar/pie/line chart a question is talking about

**As a** student taking a diagnostic,  
**I want** bar charts, pie charts, and line graphs to actually appear under the question,  
**so that** I am not asked to “look at the chart” when there is no chart.

### Acceptance criteria

1. **AC-1** — Given a question whose text or `metadata.chart` has labeled numeric series (e.g. Monday 30, Tuesday 45), When the diagnostic/history/results view renders, Then a Chart.js chart of the matching type is shown.
2. **AC-2** — Given a conceptual chart question with no series (e.g. “What does bar length represent?”), When it renders, Then no invented chart is shown.
3. **AC-3** — Given a newly generated chart-data question, When the model returns JSON, Then `metadata.chart` is present so the frontend can draw without guessing.

### Out of scope

- Photos, geometry shape pictures, number-bond / bar-model drawings
- Server-side image generation
- Rewriting the existing question bank rows

### Open questions

- Geometry “look at the figure” remains text-only this slice (existing prompt rule).
