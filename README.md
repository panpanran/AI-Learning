
# Max AI Learning

Max AI Learning is an intelligent learning platform supporting multi-subject, multi-grade, personalized practice and diagnostics.

## Features

- React frontend (Vite) + Express backend (JWT, OpenAI)
- Chinese/English switching (i18next)
- Grade/subject selection with saved preferences
- Pinecone vector retrieval, mistake notebook, targeted practice
- Multi-agent question generation (plan → generate → dedupe → evaluate/refine)
- Live generation progress bar (diagnostic + knowledge-point practice)
- Quality feedback loop (Ragas/judge → `question_feedback` + auto `prompt_patches`)
- Build-time version badge in the UI corner (`vYYYY.MMDD.HHmm`, updates on each Render deploy)
- SPA deep-link support (`/app`, `/scores`, …) via `frontend/public/_redirects`; expired sessions redirect to login

## Quick Start (Local)

### 1. Install dependencies

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in:

```
JWT_SECRET=your_jwt_secret
OPENAI_API_KEY=(optional, for OpenAI 4.1)
```

### 3. Start services

```bash
# Backend
cd backend
npm run dev

# Frontend
cd ../frontend
npm run dev
```

Access frontend: http://localhost:5173

## Deployment

Supports Render.com (current production), plus Fly.io / Vercel if you reconfigure.

### Production inventory

Public site and GitHub:

| What | Value |
|------|--------|
| Website | https://www.maxaionline.org |
| Backend API | https://ai-learning-backend-vm34.onrender.com |
| Backend (older alt) | https://ai-learning-car8.onrender.com |
| GitHub repo | https://github.com/panpanran/AI-Learning |
| Deploy branch | `master` |

Render services (dashboard):

| Service | Type | Service ID | Dashboard |
|---------|------|------------|-----------|
| Frontend (static) | Static Site | `srv-d5sjua7fte5s73cdo90g` | https://dashboard.render.com/static/srv-d5sjua7fte5s73cdo90g |
| Backend (API) | Web Service | `srv-d5slfi49c44c739chmv0` | https://dashboard.render.com/web/srv-d5slfi49c44c739chmv0 |

Managed data stores (names only — never commit secrets):

| Store | Name / identifier | Notes |
|-------|-------------------|--------|
| Neon Postgres | database `neondb` | Host looks like `ep-…-pooler.c-3.us-east-1.aws.neon.tech` (set as `DATABASE_URL` on Render) |
| Pinecone index | `ai-learning` | Region `us-east-1` (`PINECONE_INDEX_NAME`, `PINECONE_ENVIRONMENT`) |
| Pinecone host (example) | `ai-learning-….svc.aped-4627-b74a.pinecone.io` | Shown by Pinecone API / `.\scripts\dev.ps1 -CheckOnly` |

Local-only today: Python `agents/` usually runs on your machine (`AGENTS_SERVICE_URL=http://localhost:8001`). Production Render may use the Express GPT path unless you also deploy agents and set `AGENTS_SERVICE_URL` on the backend service.

Env vars that must be set on the **Render backend** (Environment tab), not in git:

- `DATABASE_URL` (Neon)
- `PINECONE_API_KEY`, `PINECONE_INDEX_NAME=ai-learning`
- `OPENAI_API_KEY`, `JWT_SECRET`
- optional: `LANGWATCH_API_KEY`, `AGENTS_SERVICE_URL`, deploy hooks

Frontend build on Render needs `VITE_BACKEND_URL=https://ai-learning-backend-vm34.onrender.com` (or whatever backend URL you use).

### How to publish so others see your changes

Render watches the GitHub repo. **Pushing to `master` triggers a new deploy.** Uncommitted local edits are invisible online until you commit + push.

**Option A — one command (recommended)**

```powershell
cd "C:\Users\panpa\Notes\Project\Python\AI Learning\maxailearning"
.\scripts\projectstart.ps1 -Action deploy -CommitMessage "your short summary"
```

This commits dirty files (if any), `git push origin master`, and optionally hits Render deploy hooks if you set them in `../.env.local`.

**Option B — plain git**

```powershell
cd "C:\Users\panpa\Notes\Project\Python\AI Learning\maxailearning"
git status
# Prefer adding specific paths — avoid `git add -A` (it can pick up .venv / build junk)
git add README.md frontend/src frontend/public/_redirects frontend/vite.config.js
git commit -m "your short summary"
git push origin master
```

Frontend SPA note: Render Static Site must serve `index.html` for client routes. This repo ships `frontend/public/_redirects` (`/* → /index.html 200`). Without it, refreshing `/app` returns **Not Found**.

Build version: each `npm run build` injects `VITE_APP_VERSION` (see `frontend/vite.config.js`). After deploy, check the top-left badge or the browser tab title (`Max AI Learning v…`).

Then open the Render dashboards above and wait until both Frontend and Backend show a successful deploy (often 2–5 minutes). Free-tier services may cold-start on the first request.

**Verify production**

```powershell
.\scripts\projectstart.ps1 -Action status
# or open:
# https://www.maxaionline.org
# https://ai-learning-backend-vm34.onrender.com/api/meta/grades
```

**Manual redeploy** (no new commit): Render dashboard → service → Manual Deploy → Deploy latest commit; or configure `RENDER_BACKEND_DEPLOY_HOOK` / `RENDER_FRONTEND_DEPLOY_HOOK` in `.env.local` and run the deploy action again.

## Project Structure

- backend/  Node.js + Express API
- frontend/ React + Vite
- agents/ Python multi-agent question generation service (FastAPI + LangGraph)
- ragas/ Python RAG evaluation scripts (Ragas)

## Question Generation Algorithm

The diagnostic question generation runs as a multi-agent pipeline in `agents/app` (entry point `orchestrators/diagnostic_run.py`): plan → generate → dedupe → evaluate/refine → persist.

### Steps

1. **Receive request** (`DiagnosticRunRequest`)
   - Inputs: language `lang`, question count `num_questions`, `student_profile`, knowledge point list `kp_list`, grade/difficulty `grade_guidance`, `retrieval_snippets`, `feedback_context`, and more.
   - The question count is clamped to `1–20` (`num = max(1, min(20, num_questions))`).

2. **Knowledge-point planning** (`agents/planner.py` → `build_knowledge_point_ids_plan`)
   - Optional: when `use_db_planner` is enabled, per-KP historical usage counts `kp_usage_counts` are read from the database.
   - Assigns a `knowledge_point_id` to each question slot: KPs are ordered by ascending usage count plus a random tiebreaker, prioritizing less-used knowledge points; when there aren't enough KPs, slots are filled by randomly sampling from the top third of the pool.
   - Produces two plans: the final `plan` (length `num`) and an over-generation `gen_plan` (length `num + 5`).

3. **LLM generation** (`agents/generator.py` → `generate_mcq_batch`)
   - Uses `prompts/diagnostic.py` to build the system and user prompts, injecting the student profile, knowledge points, assignment plan, retrieval snippets, metadata to avoid, and past feedback.
   - Calls OpenAI (default `gpt-4.1-mini`, `temperature=0.2`, JSON output mode), requiring strict JSON `{lesson, questions}`.
   - Over-generates `num + 5` questions to improve the yield of usable items.

4. **Parse & normalize** (`generator.py` → `_parse_json`, `_normalize_question`)
   - Parses the model's JSON output (falls back to extracting the outermost braces on error).
   - Normalizes each question's fields (`_coerce_question_shape`) and validates it: type must be `mcq`; exactly 4 options in each language; `answer_cn`/`answer_en` must appear in the corresponding options; otherwise the item is dropped.
   - Backfills `knowledge_point_id` from the plan (falling back to `fallback_kp_id` if it is not in the allowed set).

5. **Deduplication** (`workers/dedupe.py` → `dedupe_questions`)
   - Computes a `content_options_hash` per question: a SHA-256 over the normalized English content and options.
   - Removes duplicates within the batch first, then compares against existing database hashes `db_hashes` (queried when `check_db_hashes` is enabled).
   - Keeps the first `num` accepted questions; if too few are accepted, falls back to the raw questions to fill the gap.

6. **Quality evaluation & refinement** (`orchestrators/diagnostic.py`, LangGraph: `evaluate → critic → (refine loop)`)
   - **evaluate** (`evaluators/quality.py`):
     - Rule checks (`rules.py`): valid schema, answer present in options, single correct answer, KP assigned, matches the plan, metadata present, bilingual fields complete.
     - LLM judge (`judge.py`): `kp_alignment` (fit to the knowledge point), `explanation_support` (whether the explanation supports the answer), `distractor_quality`.
   - **critic** (`agents/critic.py`): when scores fall below the thresholds in `config.py` (e.g. `kp_alignment < 0.7`, `distractor_quality < 0.6`) or rules fail, produces a critique and rewrite instructions.
   - **route**: if refinement is enabled, `max_refine_rounds` (default 2) has not been exceeded, and questions still need fixing, go to refine; otherwise finish.
   - **refine** (`agents/refiner.py`): failing questions are rewritten one by one by the LLM according to the critique, then sent back to evaluate for re-scoring.

7. **Persist (optional)** (`workers/persist.py` → `persist_question`)
   - When `persist` is set and `grade_id`/`subject_id` are provided, each question's hash is recomputed and it is written to the database, with the generated `id` backfilled.

8. **Return response** (`DiagnosticRunResponse`)
   - Includes `run_id`, status, the KP plan and rationale, `lesson`, the final `questions`, batch quality metrics and per-question scores, refine rounds, dedupe rejection count, and the list of persisted ids.

## Ragas Evaluation

To evaluate RAG output quality (faithfulness, answer relevancy, etc.), use the `ragas/` directory:

```bash
cd ragas
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:OPENAI_API_KEY="your_openai_key"
python evaluate_ragas.py --input sample_dataset.jsonl
```

See `ragas/README.md` for more details.

## License

MIT
