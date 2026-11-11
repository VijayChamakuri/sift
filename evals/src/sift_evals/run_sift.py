"""Run Sift's engine (`sift rca`) and the logs-only error-surge control on every case of a split.

Each case runs in a fresh engine data directory (case isolation): nothing carries over except the
ranker config file. The universe is computed here for scoring only; Sift never receives it.

Run: uv run --project evals python -m sift_evals.run_sift --split dev [--config configs/rank.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb

from .data import RESULTS, ROOT, Case, cases
from .universe import case_universe

ENGINE = ROOT / "engine"
# same lexicon as engine/src/detect/rank.ts (ERROR_WORDS); the control uses it on raw lines
ERROR_WORDS = re.compile(
    r"\b(error|errors|err|exception|exceptions|fail|fails|failed|failure|fatal|panic|traceback|refused|unavailable|"
    r"timeout|timed out|deadline|denied|invalid|unable|cannot|could not|severe|warn|warning|crash|abort|aborted|reset|"
    r"broken|unreachable|unhealthy|5\d\d)\b",
    re.IGNORECASE,
)
WINDOW = 300


BLIND = ROOT / "data" / "blind"


def blind_logs(case: Case) -> Path:
    """The case's logs under an anonymous name: RCAEval directory names contain the root cause."""
    name = hashlib.sha256(f"sift-blind:{case.case}".encode()).hexdigest()[:16]
    path = BLIND / name / "logs.parquet"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        os.link(case.dir / "logs.parquet", path)
    return path


def sift_command(case: Case, config: Path | None) -> list[str]:
    cmd = [
        "node",
        str(ENGINE / "dist/surfaces/cli.js"),
        "rca",
        "--logs",
        str(blind_logs(case)),
        "--at",
        str(case.inject_time),
        "--json",
    ]
    if config:
        cmd += ["--config", str(config)]
    return cmd


def sift_rca(case: Case, config: Path | None) -> tuple[list[str] | None, dict]:
    cmd = sift_command(case, config)
    t0 = time.perf_counter()
    p = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=600)
    meta = {"seconds": round(time.perf_counter() - t0, 3)}
    if p.returncode != 0:
        meta["error"] = (p.stderr or p.stdout).strip().splitlines()[:2]
        return None, meta
    out = json.loads(p.stdout)
    meta |= {
        "records": out["records"],
        "templates": out["templates"],
        "ingest_ms": out["ingestMs"],
        "top": out["ranking"][:3],
    }
    return [r["service"] for r in out["ranking"]], meta


def error_surge(case: Case) -> list[str]:
    con = duckdb.connect()  # one connection per call: the harness runs cases in threads
    rows = con.sql(
        f"""select container_name, timestamp >= {case.inject_time} as after, message
            from read_parquet('{case.dir / "logs.parquet"}')
            where timestamp >= {case.inject_time - WINDOW} and timestamp < {case.inject_time + WINDOW}"""
    ).fetchall()
    surge: dict[str, int] = {}
    for svc, after, msg in rows:
        if msg and ERROR_WORDS.search(msg):
            surge[svc] = surge.get(svc, 0) + (1 if after else -1)
    return [s for s, v in sorted(surge.items(), key=lambda kv: (-kv[1], kv[0])) if v > 0]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True, choices=["dev", "test_a", "test_b"])
    ap.add_argument("--config", type=Path)
    ap.add_argument("--method", default="sift")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    if args.split != "dev":
        from .guard import require_preregistered

        require_preregistered(args.split)
    subprocess.run(["pnpm", "-s", "build"], cwd=ENGINE, check=True)
    split_cases = cases(args.split)
    universes = {c.case: case_universe(c) for c in split_cases}

    def one(c: Case) -> list[dict]:
        ranks, meta = sift_rca(c, args.config)
        rows = [
            {
                "case": c.case,
                "method": args.method,
                "universe": universes[c.case],
                "ranks": ranks,
                "error": meta.pop("error", None),
                **meta,
            }
        ]
        if args.method == "sift":
            rows.append(
                {
                    "case": c.case,
                    "method": "control:error-surge",
                    "universe": universes[c.case],
                    "ranks": error_surge(c),
                    "error": None,
                }
            )
        return rows

    with ThreadPoolExecutor(args.workers) as pool:
        results = [r for rows in pool.map(one, split_cases) for r in rows]
    out = RESULTS / "q1" / args.split / f"{args.method.replace(':', '_')}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r) + "\n" for r in results))
    failed = sum(1 for r in results if r["ranks"] is None)
    print(f"{len(split_cases)} cases, {failed} failed -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
