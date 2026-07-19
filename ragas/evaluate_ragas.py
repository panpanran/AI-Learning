import argparse
import json
import os
from pathlib import Path

from datasets import Dataset
from dotenv import load_dotenv
from openai import OpenAI
from ragas import evaluate
from ragas.embeddings.base import embedding_factory
from ragas.llms import llm_factory
from ragas.metrics._answer_relevance import answer_relevancy
from ragas.metrics._context_precision import context_precision
from ragas.metrics._context_recall import context_recall
from ragas.metrics._faithfulness import faithfulness

METRIC_FIELDS = (
    "faithfulness",
    "answer_relevancy",
    "context_precision",
    "context_recall",
)


def load_env() -> None:
    here = Path(__file__).resolve().parent
    candidates = [
        Path(os.getenv("DOTENV_PATH", "")),
        here.parent.parent / ".env.local",
        here / ".env",
    ]
    for path in candidates:
        if path and path.exists():
            load_dotenv(path, override=False)
    load_dotenv(override=False)


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(f"JSONL parse error line {line_no}: {exc}") from exc

            required = ["question", "answer", "contexts"]
            missing = [key for key in required if key not in row]
            if missing:
                raise ValueError(f"Line {line_no} missing fields: {', '.join(missing)}")

            if not isinstance(row["contexts"], list) or not all(
                isinstance(x, str) for x in row["contexts"]
            ):
                raise ValueError(f"Line {line_no}: contexts must be string[]")

            rows.append(row)

    if not rows:
        raise ValueError("Input file is empty")

    return rows


def pick_metrics(rows: list[dict]):
    # Phase 1: diagnostic MCQ is not RAG — only answer relevancy is meaningful here.
    return [answer_relevancy]


def compute_aggregate(records: list[dict]) -> dict:
    aggregate: dict = {}
    for field in METRIC_FIELDS:
        values = []
        for row in records:
            if field not in row:
                continue
            try:
                val = float(row[field])
                if val == val:  # skip NaN
                    values.append(val)
            except (TypeError, ValueError):
                continue
        if values:
            aggregate[field] = round(sum(values) / len(values), 4)
    return aggregate


def sanitize_for_json(value):
    if isinstance(value, float) and value != value:
        return None
    if isinstance(value, dict):
        return {k: sanitize_for_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_for_json(v) for v in value]
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Ragas evaluation on a JSONL dataset")
    parser.add_argument("--input", type=str, required=True, help="Path to JSONL dataset")
    parser.add_argument(
        "--output",
        type=str,
        default="ragas_result.json",
        help="Path to write aggregated result JSON",
    )
    parser.add_argument("--quiet", action="store_true", help="Only print output path")
    args = parser.parse_args()

    load_env()

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing OPENAI_API_KEY")

    input_path = Path(args.input).resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")

    rows = load_jsonl(input_path)
    dataset = Dataset.from_list(rows)
    metrics = pick_metrics(rows)

    judge_model = os.getenv("RAGAS_JUDGE_MODEL", "gpt-4o-mini")
    client = OpenAI(api_key=api_key)
    llm = llm_factory(judge_model, client=client)
    embeddings = embedding_factory("openai", model="text-embedding-3-small", client=client)

    result = evaluate(dataset=dataset, metrics=metrics, llm=llm, embeddings=embeddings)
    records = result.to_pandas().to_dict(orient="records")
    aggregate = compute_aggregate(records)

    result_dict = sanitize_for_json({
        "aggregate": aggregate,
        "rows": records,
        "metrics": [getattr(m, "name", str(m)) for m in metrics],
    })

    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(result_dict, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    if args.quiet:
        print(str(output_path))
    else:
        print("Ragas evaluation complete")
        print(json.dumps(result_dict, ensure_ascii=False, indent=2))
        print(f"Result file: {output_path}")


if __name__ == "__main__":
    main()
