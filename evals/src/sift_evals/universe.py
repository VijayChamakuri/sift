"""The candidate set every method ranks over, and the map from telemetry names to services.

The universe of a case is RCAEval's own candidate rule (main.py, the `n_candidates_map`
behind its Chance@5): metric columns in the analysis window, minus `time`, minus
`_latency-50`, Train Ticket restricted to `ts-` columns, then `drop_constant`; a service is
the column prefix before `_` with `-db` removed. Sift and every baseline are scored over
this same set, so AC@k and the chance floor share one answer space.
"""

from __future__ import annotations

import duckdb
import pandas as pd
from RCAEval.io.time_series import drop_constant

from .data import Case

WINDOW_SECONDS = 300  # RCAEval main.py default: --length 10 minutes, half before and half after


def _window(df: pd.DataFrame, inject_time: int, col: str = "time") -> pd.DataFrame:
    before = df[df[col] < inject_time].tail(WINDOW_SECONDS)
    after = df[df[col] >= inject_time].head(WINDOW_SECONDS)
    return pd.concat([before, after], ignore_index=True)


def load_metrics(case: Case) -> pd.DataFrame:
    """Metrics in the analysis window, cleaned exactly as RCAEval's main.py does before ranking."""
    df = duckdb.sql(f"select * from read_parquet('{case.dir / 'metrics.parquet'}') order by time").df()
    df = df.loc[:, ~df.columns.str.endswith("_latency-50")]
    if case.system == "tt":
        time_col = df["time"]
        df = df.loc[:, df.columns.str.startswith("ts-")]
        df["time"] = time_col
    df = df.replace([float("inf"), float("-inf")], float("nan")).ffill().fillna(0)
    return _window(df, case.inject_time)


def services_of(columns: list[str]) -> list[str]:
    return sorted({c.split("_")[0].replace("-db", "") for c in columns if c != "time"})


def case_universe(case: Case, metrics: pd.DataFrame | None = None) -> list[str]:
    metrics = load_metrics(case) if metrics is None else metrics
    kept = drop_constant(metrics.drop(columns=["time"]))
    return services_of(list(kept.columns))


def to_service(name: str, universe: list[str]) -> str | None:
    """Map a container, trace service or metric entity to a universe service, or None.

    Rules, in order: exact match; drop a `-db` suffix; drop a trailing `service`
    (`frontendservice` -> `frontend`).
    """
    if name in universe:
        return name
    for candidate in (name.removesuffix("-db"), name.removesuffix("service")):
        if candidate in universe:
            return candidate
    return None
