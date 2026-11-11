"""M0 data audit: what the logs can and cannot see, before any method is designed.

Dev cases are inspected in full. Test A and Test B are audited from the case index only
(counts and labels' shape, no telemetry), so this step does not expose their faults.

Run: uv run --project evals python -m sift_evals.audit
"""

from __future__ import annotations

import statistics
from collections import defaultdict

import duckdb

from .data import RESULTS, SPLITS, cases, dump
from .universe import case_universe, to_service


def _log_counts(case_dir: str) -> dict[str, int]:
    rows = duckdb.sql(
        f"select container_name, count(*) from read_parquet('{case_dir}/logs.parquet') group by 1"
    ).fetchall()
    return {r[0]: int(r[1]) for r in rows}


def _dev_entry(dc: list) -> dict:
    sizes, rc_in_universe = [], 0
    rc_lines: dict[str, list[int]] = defaultdict(list)
    never_log: dict[str, int] = defaultdict(int)
    unmapped: set[str] = set()
    for c in dc:
        uni = case_universe(c)
        sizes.append(len(uni))
        rc_in_universe += c.root_cause_service in uni
        by_service: dict[str, int] = defaultdict(int)
        for name, n in _log_counts(str(c.dir)).items():
            svc = to_service(name, uni)
            if svc is None:
                unmapped.add(name)
            else:
                by_service[svc] += n
        rc_lines[c.root_cause_service].append(by_service.get(c.root_cause_service, 0))
        for s in uni:
            never_log[s] += by_service.get(s, 0) == 0
    return {
        "universe_size": {"min": min(sizes), "median": statistics.median(sizes), "max": max(sizes)},
        "root_cause_in_universe": f"{rc_in_universe}/{len(dc)}",
        "root_cause_log_lines_median": {s: statistics.median(v) for s, v in sorted(rc_lines.items())},
        "root_cause_cases_with_any_log": {
            s: f"{sum(1 for n in v if n > 0)}/{len(v)}" for s, v in sorted(rc_lines.items())
        },
        "universe_services_silent_in_n_cases": dict(sorted(never_log.items())),
        "log_containers_outside_universe": sorted(unmapped),
    }


def audit() -> dict:
    out: dict = {"splits": {}}
    for split in SPLITS:
        split_cases = cases(split)
        per_dataset: dict = {}
        for ds in SPLITS[split]:
            dc = [c for c in split_cases if c.dataset == ds]
            entry = {
                "cases": len(dc),
                "root_cause_services": sorted({c.root_cause_service for c in dc}),
                "faults": sorted({c.fault for c in dc}),
                "scenarios": len({c.scenario for c in dc}),
                "cases_without_logs": sorted(c.case for c in dc if c.n_logs == 0),
                "log_lines_median": statistics.median(c.n_logs for c in dc),
                "log_lines_total": sum(c.n_logs for c in dc),
            }
            if split == "dev":
                entry |= _dev_entry(dc)
            per_dataset[ds] = entry
        out["splits"][split] = per_dataset
    return out


def main() -> None:
    result = audit()
    dump(RESULTS / "audit" / "audit.json", result)
    for split, per in result["splits"].items():
        for ds, e in per.items():
            print(
                split,
                ds,
                e["cases"],
                "cases,",
                e["scenarios"],
                "scenarios, no-log cases:",
                e["cases_without_logs"],
            )
            if split == "dev":
                print("   universe", e["universe_size"], "rc in universe", e["root_cause_in_universe"])
                print("   rc cases with any log", e["root_cause_cases_with_any_log"])
                print("   outside universe", e["log_containers_outside_universe"])


if __name__ == "__main__":
    main()
