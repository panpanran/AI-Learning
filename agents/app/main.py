from __future__ import annotations

from fastapi import FastAPI

from app.config import load_env
from app.models import DiagnosticRunRequest, DiagnosticRunResponse, QualityRunRequest, QualityRunResponse
from app.orchestrators.diagnostic import run_diagnostic_quality
from app.orchestrators.diagnostic_run import run_diagnostic_run

load_env()

app = FastAPI(title="Max AI Learning Agents", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok", "service": "maxailearning-agents"}


@app.post("/v1/diagnostic/quality/run", response_model=QualityRunResponse)
def diagnostic_quality_run(request: QualityRunRequest):
    return run_diagnostic_quality(request)


@app.post("/v1/diagnostic/run", response_model=DiagnosticRunResponse)
def diagnostic_run(request: DiagnosticRunRequest):
    return run_diagnostic_run(request)
