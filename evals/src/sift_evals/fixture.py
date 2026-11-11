"""Build the bundled demo fixture: one Dev case, trimmed to the analysis window.

Only a Dev case may be bundled (Test cases never leave data/). The fixture keeps the logs within
300 s of the injection time plus the injection time and the ground truth, attributed to RCAEval
(MIT licence).

Run: uv run --project evals python -m sift_evals.fixture --case re2ob_productcatalogservice_loss_1
"""

from __future__ import annotations

import argparse
import json

import duckdb

from .data import RCAEVAL_COMMIT, ROOT, SPLITS, cases

OUT = ROOT / "fixtures" / "demo"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", required=True)
    args = ap.parse_args()
    dev = {c.case: c for c in cases("dev")}
    if args.case not in dev:
        raise SystemExit(
            f"SIFT-E401 {args.case} is not a Dev case ({', '.join(SPLITS['dev'])}); only Dev cases may be bundled\n"
            "fix: pick a case from data/rcaeval/cases.parquet with dataset RE2-OB or RE3-OB"
        )
    c = dev[args.case]
    OUT.mkdir(parents=True, exist_ok=True)
    duckdb.sql(
        f"""copy (select * from read_parquet('{c.dir / "logs.parquet"}')
                  where timestamp >= {c.inject_time - 300} and timestamp < {c.inject_time + 300})
            to '{OUT / "logs.parquet"}' (format parquet, compression zstd)"""
    )
    n = duckdb.sql(f"select count(*) from read_parquet('{OUT / 'logs.parquet'}')").fetchall()[0][0]
    (OUT / "case.json").write_text(
        json.dumps(
            {
                "case": c.case,
                "dataset": c.dataset,
                "inject_time": c.inject_time,
                "root_cause_service": c.root_cause_service,
                "fault": c.fault,
                "lines": n,
                "window_seconds": 300,
                "source": f"RCAEval (Pham et al., WWW 2025), MIT licence, https://github.com/phamquiluan/RCAEval @ {RCAEVAL_COMMIT}",
            },
            indent=2,
        )
        + "\n"
    )
    print(f"{c.case}: {n} lines -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
