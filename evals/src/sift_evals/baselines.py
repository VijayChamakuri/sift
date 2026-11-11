"""RCAEval baselines, run with RCAEval's own method code on the same cases and windows as Sift.

Methods:
- `baro`              RCAEval BARO on metrics (its metric-based method).
- `mmbaro:<signals>`  RCAEval multi-source BARO with only the named signals
                      (metrics, logs, traces, all). Holding the method fixed and varying
                      the input is the signal ablation: it isolates what each signal carries.

The derived log and trace series are built with RCAEval's own converter
(RCAEval.convert.derive), cached per case under data/derived/.

Run: uv run --project evals python -m sift_evals.baselines --split dev
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback

import duckdb
import pandas as pd
from RCAEval.convert.derive import log_series, trace_series
from RCAEval.e2e.baro import baro, mmbaro

from .data import DATA, RESULTS, Case, cases, dump
from .universe import case_universe, load_metrics

DERIVED = DATA / "derived"
BINS_EACH_SIDE = 20  # main.py: logts_length = length * 4 // 2 with length = 10
VARIANTS = {
    "metrics": ("metrics",),
    "logs": ("logs",),
    "traces": ("traces",),
    "all": ("metrics", "logs", "traces"),
}


def _bin_window(df: pd.DataFrame, inject_time: int) -> pd.DataFrame:
    if df.empty:
        return df
    before = df[df["time"] < inject_time].tail(BINS_EACH_SIDE)
    after = df[df["time"] >= inject_time].head(BINS_EACH_SIDE)
    return pd.concat([before, after], ignore_index=True)


def derived(case: Case) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """(logts, tracets_err, tracets_lat), windowed like RCAEval's main.py."""
    out = DERIVED / case.case
    paths = [out / f"{n}.parquet" for n in ("logts", "tracets_err", "tracets_lat")]
    if not all(p.exists() for p in paths):
        out.mkdir(parents=True, exist_ok=True)
        logs = (
            duckdb.sql(
                f"select timestamp, container_name, message from read_parquet('{case.dir / 'logs.parquet'}')"
            ).df()
            if case.has_logs
            else pd.DataFrame()  # no log file: logs-only variants get no signal, the others still run
        )
        if logs.empty:
            logts = pd.DataFrame({"time": []})
        else:
            # the Parquet copy stores seconds; RCAEval's converter expects nanoseconds
            logs["timestamp"] = logs["timestamp"].astype("int64") * 1_000_000_000
            logts, _, _ = log_series(logs)
        tpath = case.dir / "traces.parquet"
        if tpath.exists():
            traces = duckdb.sql(f"select * from read_parquet('{tpath}')").df()
            err, lat = (
                trace_series(traces, case.inject_time)
                if not traces.empty
                else (pd.DataFrame(), pd.DataFrame())
            )
        else:
            err, lat = pd.DataFrame(), pd.DataFrame()
        for df, p in zip((logts, err, lat), paths, strict=True):
            df.columns = [str(c) for c in df.columns]
            df.to_parquet(p, index=False)
    logts, err, lat = (pd.read_parquet(p) for p in paths)
    return tuple(_bin_window(d, case.inject_time) for d in (logts, err, lat))  # type: ignore[return-value]


def run_method(method: str, case: Case, metrics: pd.DataFrame) -> list[str]:
    dataset = case.dataset.lower()
    if method == "baro":
        return baro(metrics, case.inject_time, dataset=dataset)["ranks"]
    signals = VARIANTS[method.split(":", 1)[1]]
    logts, err, lat = derived(case)
    data = {
        "metric": metrics if "metrics" in signals else metrics[["time"]],
        "logts": logts if "logs" in signals and not logts.empty else pd.DataFrame({"time": metrics["time"]}),
        "tracets_err": err if "traces" in signals else pd.DataFrame(),
        "tracets_lat": lat if "traces" in signals else pd.DataFrame(),
    }
    return mmbaro(data, case.inject_time, dataset=dataset)["ranks"]


METHODS = ["baro"] + [f"mmbaro:{v}" for v in VARIANTS]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True, choices=["dev", "test_a", "test_b"])
    args = ap.parse_args()
    if args.split != "dev":
        from .guard import require_preregistered

        require_preregistered(args.split)
    out_path = RESULTS / "q1" / args.split / "baselines.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for case in cases(args.split):
        metrics = load_metrics(case)
        universe = case_universe(case, metrics)
        for method in METHODS:
            t0 = time.perf_counter()
            try:
                ranks, error = run_method(method, case, metrics), None
            except Exception as e:  # every case counts: a failure is recorded and scored as a miss
                ranks, error = None, f"{type(e).__name__}: {e}"
                traceback.print_exc(file=sys.stderr)
            rows.append(
                {
                    "case": case.case,
                    "method": method,
                    "universe": universe,
                    "ranks": ranks[:50] if ranks is not None else None,
                    "error": error,
                    "seconds": round(time.perf_counter() - t0, 3),
                }
            )
        print(case.case, flush=True)
    out_path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    dump(
        RESULTS / "q1" / args.split / "baselines_meta.json",
        {"methods": METHODS, "cases": len(rows) // len(METHODS)},
    )


if __name__ == "__main__":
    main()
