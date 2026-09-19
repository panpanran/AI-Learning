# Technical story — Chart.js question charts

**Packages:** `frontend`, `backend` (prompt + history/results metadata), `agents` (prompt parity)

**Approach:** Structured `metadata.chart` from the generator; frontend `parseQuestionChart` (spec first, then conservative text extract); Chart.js canvas on diagnostic / results / history. No stored images.

### Files (expected)

| Path | Change |
|------|--------|
| `frontend/src/parseQuestionChart.ts` | Spec + text fallback |
| `frontend/src/QuestionChart.tsx` | Chart.js render |
| `frontend/src/App.tsx`, `Results.tsx`, `HistoryPage.tsx` | Mount chart |
| `backend/lib/prompts.js` + `agents/app/prompts/diagnostic.py` | Emit `metadata.chart` |
| `backend/index.js` `/api/history/full` + `/api/questions/by-ids` | Pass `metadata` |

### AC → checks

| AC | Check |
|----|-------|
| AC-1 | Unit: parse labeled series → spec; manual Chart.js on diagnostic |
| AC-2 | Unit: conceptual stem → null |
| AC-3 | Prompt text includes chart schema; new gens include `metadata.chart` |

### DoD

- FS Ready → code → FS As-built filled
- Chart.js MIT; no secrets
