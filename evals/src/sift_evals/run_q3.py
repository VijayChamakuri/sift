"""Q3: run `sift watch` (sensors -> gate -> local model) on every case of a split, forward-only.

Sift gets only the case's logs through an anonymised path; the injection time is never passed and is
used only by score_q3.py. One run records every signal with its gate decision and model verdict, so
all three rungs (raw sensors, + gate, + model) are scored from the same replay.

Needs a local OpenAI-compatible model server, e.g.:
  mlx_lm.server --model mlx-community/Qwen2.5-3B-Instruct-4bit --port 8090
Run: uv run --project evals python -m sift_evals.run_q3 --split dev
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .data import NO_LOGS, RESULTS, ROOT, Case, cases
from .run_sift import ENGINE, blind_logs

DEFAULT_LLM = "http://127.0.0.1:8090/v1"


def watch(case: Case, config: Path | None, llm_url: str | None, max_llm: int) -> dict:
    if not case.has_logs:
        return {"case": case.case, "seconds": 0.0, "error": [NO_LOGS], "result": None}
    cmd = [
        "node",
        str(ENGINE / "dist/surfaces/cli.js"),
        "watch",
        "--logs",
        str(blind_logs(case)),
        "--json",
        "--max-llm",
        str(max_llm),
    ]
    if config:
        cmd += ["--config", str(config)]
    env = dict(os.environ)
    if llm_url:
        env["SIFT_LLM_BASE_URL"] = llm_url
    else:
        cmd.append("--no-llm")
    t0 = time.perf_counter()
    p = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=1800, env=env)
    row: dict = {"case": case.case, "seconds": round(time.perf_counter() - t0, 2)}
    if p.returncode != 0:
        row |= {"error": (p.stderr or p.stdout).strip().splitlines()[:2], "result": None}
        return row
    out = json.loads(p.stdout)
    # keep what scoring and the write-up need; evidence text stays for the examples
    row["result"] = {
        "start": out["start"],
        "end": out["end"],
        "lines": out["lines"],
        "model": out["model"],
        "llmCalls": out["llmCalls"],
        "llmMs": out["llmMs"],
        "config": out["config"],
        "investigations": [
            {
                "service": i["signal"]["service"],
                "sensor": i["signal"]["sensor"],
                "at": i["signal"]["at"],
                "value": i["signal"]["value"],
                "detail": i["signal"]["detail"],
                "gate": i["gate"],
                "resolvedAt": i["resolvedAt"],
                "censored": i["censored"],
                "llmSkipped": i["llmSkipped"],
                "llm": None
                if not i["llm"]
                else {
                    k: i["llm"][k]
                    for k in (
                        "ok",
                        "verdict",
                        "service",
                        "summary",
                        "cited",
                        "failure",
                        "latencyMs",
                        "inputTokens",
                        "outputTokens",
                    )
                },
                "evidence": i["evidence"],
            }
            for i in out["investigations"]
        ],
    }
    row["error"] = None
    return row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True, choices=["dev", "test_a", "test_b"])
    ap.add_argument("--config", type=Path)
    ap.add_argument(
        "--llm", default=DEFAULT_LLM, help="OpenAI-compatible base URL; 'none' runs without the model"
    )
    ap.add_argument("--max-llm", type=int, default=8)
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()
    if args.split != "dev":
        from .guard import require_preregistered

        require_preregistered(args.split)
    subprocess.run(["pnpm", "-s", "build"], cwd=ENGINE, check=True)
    llm = None if args.llm == "none" else args.llm
    split_cases = cases(args.split)
    with ThreadPoolExecutor(args.workers) as pool:
        rows = list(pool.map(lambda c: watch(c, args.config, llm, args.max_llm), split_cases))
    out = RESULTS / "q3" / args.split / "watch.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r) + "\n" for r in rows))
    failed = sum(1 for r in rows if r["result"] is None)
    print(f"{len(rows)} cases, {failed} failed -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
