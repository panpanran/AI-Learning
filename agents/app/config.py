import os
from pathlib import Path

from dotenv import load_dotenv

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent.parent


def load_env() -> None:
    candidates = [
        Path(os.getenv("DOTENV_PATH", "")),
        _ROOT.parent / ".env.local",
        _ROOT / ".env",
    ]
    for path in candidates:
        if path and path.exists():
            load_dotenv(path, override=False)
    load_dotenv(override=False)


load_env()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
DIAG_EVAL_MODEL = os.getenv("DIAG_EVAL_MODEL", "gpt-4o-mini")
MAX_REFINE_ROUNDS = int(os.getenv("DIAG_MAX_REFINE_ROUNDS", "2"))

THRESHOLDS = {
    "negative_kp_alignment": float(os.getenv("FEEDBACK_NEGATIVE_KP_ALIGNMENT", "0.7")),
    "negative_distractor_quality": float(os.getenv("FEEDBACK_NEGATIVE_DISTRACTOR", "0.6")),
    "negative_response_relevancy": float(os.getenv("FEEDBACK_NEGATIVE_RELEVANCY", "0.5")),
}
