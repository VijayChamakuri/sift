"""Score every Q1 method on a split: AC@k, Avg@5, chance and lift, per dataset and per fault type,
with paired cluster-bootstrap intervals. Reads results/q1/<split>/*.jsonl, writes summary.json.

Every case of the split must have an outcome for every method; a missing case fails the run.

Run: uv run --project evals python -m sift_evals.score_q1 --split dev
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict

from .data import RESULTS, cases, dump
from .run_sift import ERROR_WORDS
from .scoring import CaseScore, cluster_bootstrap, paired_difference, score_case, service_ranking, summarize

# Evidence behind Sift's correct top-1 picks, classified by a fixed keyword rule (pre-registered).
RESTART = re.compile(
    r"start(ing|ed)?\b|initializ|shut(ting)? ?down|listening on port|profil(er|ing)|tracing enabled|stats enabled",
    re.IGNORECASE,
)


def evidence_kind(evidence: list[dict]) -> str:
    texts = [(e.get("example") or e.get("template") or "") for e in evidence if e.get("kind") != "shift"]
    if any(RESTART.search(t) for t in texts):
        return "restart or redeploy"
    if any(ERROR_WORDS.search(t) for t in texts):
        return "error lines"
    if any(e.get("kind") == "shift" for e in evidence):
        return "volume shift"
    return "other new templates" if texts else "weak (no single item above threshold)"


def evidence_breakdown(split_cases: list, rows: dict[str, dict]) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for c in split_cases:
        r = rows.get(c.case)
        if r and r["ranks"] and r["ranks"][0] == c.root_cause_service:
            out[evidence_kind((r.get("top") or [{}])[0].get("evidence", []))] += 1
    return dict(out)


def load_runs(split: str) -> dict[str, dict[str, dict]]:
    runs: dict[str, dict[str, dict]] = defaultdict(dict)
    for path in sorted((RESULTS / "q1" / split).glob("*.jsonl")):
        for line in path.read_text().splitlines():
            r = json.loads(line)
            runs[r["method"]][r["case"]] = r
    return runs


def score_split(split: str) -> dict:
    all_cases = cases(split)
    runs = load_runs(split)
    per_method: dict[str, list[CaseScore]] = {}
    top1: dict[str, dict[str, int]] = {}
    for method, by_case in runs.items():
        missing = [c.case for c in all_cases if c.case not in by_case]
        if missing:
            raise SystemExit(
                f"SIFT-E104 {method} has no outcome for {len(missing)} cases of {split} (first: {missing[0]})\n"
                f"fix: rerun {method} on {split}"
            )
        scores = []
        firsts: dict[str, int] = defaultdict(int)
        for c in all_cases:
            r = by_case[c.case]
            ranking = None if r["ranks"] is None else service_ranking(r["ranks"], r["universe"])
            scores.append(score_case(c, ranking, r["universe"]))
            if ranking:
                firsts[ranking[0]] += 1
        per_method[method] = scores
        top1[method] = dict(firsts)

    out: dict = {"split": split, "methods": {}, "by_dataset": {}, "by_fault": {}, "paired": {}}
    # default-pick check: a method that ranks one service first in most cases looks good whenever
    # that service is the answer; compare each method's top-1 share with the answer's share
    answers: dict[str, int] = defaultdict(int)
    for c in all_cases:
        answers[c.root_cause_service] += 1
    out["top1_concentration"] = {
        m: {
            "most_ranked_first": max(f, key=f.get) if f else None,
            "share_ranked_first": round(max(f.values()) / len(all_cases), 3) if f else 0.0,
            "share_as_answer": round(answers.get(max(f, key=f.get), 0) / len(all_cases), 3) if f else 0.0,
        }
        for m, f in top1.items()
    }
    cis = cluster_bootstrap(per_method)
    for m, scores in per_method.items():
        out["methods"][m] = summarize(scores) | {"avg5_ci": cis[m]}
    datasets = sorted({c.dataset for c in all_cases})
    for ds in datasets:
        idx = [i for i, c in enumerate(all_cases) if c.dataset == ds]
        sub = {m: [s[i] for i in idx] for m, s in per_method.items()}
        ds_ci = cluster_bootstrap(sub)
        out["by_dataset"][ds] = {m: summarize(s) | {"avg5_ci": ds_ci[m]} for m, s in sub.items()}
    for fault in sorted({c.fault for c in all_cases}):
        idx = [i for i, c in enumerate(all_cases) if c.fault == fault]
        out["by_fault"][fault] = {m: summarize([s[i] for i in idx]) for m, s in per_method.items()}
    if "sift" in runs:
        out["sift_top1_evidence"] = evidence_breakdown(all_cases, runs["sift"])
    ref = "mmbaro:logs"
    if ref in per_method:
        for m in per_method:
            if m != ref:
                out["paired"][f"{m} - {ref}"] = paired_difference(per_method[m], per_method[ref])
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True)
    args = ap.parse_args()
    out = score_split(args.split)
    dump(RESULTS / "q1" / args.split / "summary.json", out)
    print(f"{'method':22} {'AC@1':>6} {'AC@3':>6} {'Avg@5':>6}  95% CI        lift  failed")
    for m, s in sorted(out["methods"].items(), key=lambda kv: -kv[1]["avg5"]):
        lo, hi = s["avg5_ci"]
        print(
            f"{m:22} {s['ac1']:6.3f} {s['ac3']:6.3f} {s['avg5']:6.3f}  [{lo:.3f},{hi:.3f}] {s['lift5']:+.3f}  {s['failed']}"
        )
    print("\ntop-1 concentration (share ranked first vs share as answer):")
    for m, t in out["top1_concentration"].items():
        print(
            f"  {m:22} {t['most_ranked_first']}: {t['share_ranked_first']:.2f} vs {t['share_as_answer']:.2f}"
        )
    print("\nSift top-1 hits by evidence:", out.get("sift_top1_evidence"))
    print("\nAvg@5 by fault:")
    methods = sorted(out["methods"])
    print(f"{'fault':8} " + " ".join(f"{m[:14]:>14}" for m in methods))
    for f, per in out["by_fault"].items():
        print(f"{f:8} " + " ".join(f"{per[m]['avg5']:14.3f}" for m in methods))


if __name__ == "__main__":
    main()
