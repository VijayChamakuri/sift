"""Dev-only tuning of the ranker weights: a small, fully logged grid. Every configuration tried is
kept, so the reported Dev number is known to be the best of N.

  --variant v1   results/q1/dev/tuning.json     -> configs/rank.json     (frozen before Test A)
  --variant v2   results/q1/dev/tuning_v2.json  -> configs/rank_v2.json  (novelty baseline; frozen
                                                                          before Test B)

Test splits only ever run the frozen files.

Run: uv run --project evals python -m sift_evals.tune --variant v2
"""

from __future__ import annotations

import argparse
import itertools
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor

from .data import RESULTS, ROOT, cases, dump
from .run_sift import ENGINE, sift_rca
from .scoring import score_case, service_ranking, summarize
from .universe import case_universe

GRID = {"errorWeight": [0.5, 1, 2], "wShift": [0.5, 1, 2], "wSurge": [0.5, 1]}
VARIANTS = {
    # round 1 (results/q1/dev/history/tuning_round1.json) was superseded by a Dev bias fix
    "v1": {
        "base": {"windowSeconds": 300, "wNovelty": 1, "minCount": 1},
        "out": "tuning.json",
        "config": "rank.json",
        "round": 2,
        "previous": "results/q1/dev/history/tuning_round1.json",
    },
    # designed after Test A showed chatty services being novel by default; Test A is not used to tune it
    "v2": {
        "base": {"windowSeconds": 300, "wNovelty": 1, "minCount": 1, "noveltyBaseline": True},
        "out": "tuning_v2.json",
        "config": "rank_v2.json",
        "round": 1,
        "previous": None,
    },
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", choices=list(VARIANTS), default="v1")
    args = ap.parse_args()
    v = VARIANTS[args.variant]
    subprocess.run(["pnpm", "-s", "build"], cwd=ENGINE, check=True)
    dev = cases("dev")
    universes = {c.case: case_universe(c) for c in dev}
    cfg_dir = ROOT / "configs" / "grid"
    for old in cfg_dir.glob("*.json"):
        old.unlink()
    cfg_dir.mkdir(parents=True, exist_ok=True)
    trials = []
    for values in itertools.product(*GRID.values()):
        cfg = v["base"] | dict(zip(GRID, values, strict=True))
        name = "_".join(f"{k}{x}" for k, x in zip(GRID, values, strict=True))
        path = cfg_dir / f"{args.variant}_{name}.json"
        path.write_text(json.dumps(cfg, indent=2) + "\n")
        with ThreadPoolExecutor(4) as pool:
            ranks = list(pool.map(lambda c, p=path: sift_rca(c, p)[0], dev))
        scores = [
            score_case(c, None if r is None else service_ranking(r, universes[c.case]), universes[c.case])
            for c, r in zip(dev, ranks, strict=True)
        ]
        s = summarize(scores)
        trials.append({"name": name, "config": cfg, **s})
        print(f"{name:40} AC@1 {s['ac1']:.3f}  Avg@5 {s['avg5']:.3f}", flush=True)
    best = max(trials, key=lambda t: (t["avg5"], t["ac1"]))
    dump(
        RESULTS / "q1" / "dev" / v["out"],
        {
            "variant": args.variant,
            "grid": GRID,
            "base": v["base"],
            "trials": trials,
            "chosen": best["name"],
            "rule": "max Dev Avg@5, ties by AC@1",
            "round": v["round"],
            "previous": v["previous"],
        },
    )
    (ROOT / "configs" / v["config"]).write_text(json.dumps(best["config"], indent=2) + "\n")
    print("chosen:", best["name"], best["avg5"])


if __name__ == "__main__":
    main()
