"""Score Q3 (investigate before alert) from results/q3/<split>/watch.jsonl.

Rungs, all from the same forward-only replay:
  raw     every sensor firing opens an issue at its firing time
  gate    a firing opens an issue only if the deterministic gate passes (at t + gate)
  model   gate passes and the local model answers "open"; if the model's answer was unusable
          (empty, unparsable, bad citation, unknown service, unavailable), the gate decision stands
          and the failure is counted

Per case, with injection time T (known only here) and detection window W:
  detected (any)      some issue opened in [T, T + W]
  detected (correct)  the first issue in [T, T + W] names the root-cause service
                      (model rung: the service the model named; other rungs: the signal's service)
  delay               first issue time in [T, T + W] minus T
  false issues        issues opened before T, per hour of monitored time before T
  censored            the recording ends before T + W (counted, excluded from recall)
Repeat issues with the same stable name (service, sensor) in a case are deduplicated.

Run: uv run --project evals python -m sift_evals.score_q3 --split dev
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
from collections import Counter, defaultdict

from .data import RESULTS, cases, dump

WINDOW = 300  # detection window after injection, seconds
RUNGS = ("raw", "gate", "model")


def issues(result: dict, rung: str) -> list[dict]:
    """Issues a rung opens, in time order, deduplicated by (service, sensor)."""
    out, seen = [], set()
    for i in sorted(result["investigations"], key=lambda x: x["at"]):
        if rung == "raw":
            opened, at, service = True, i["at"], i["service"]
        else:
            if not i["gate"]["pass"]:
                continue
            at, service, opened = i["resolvedAt"], i["service"], True
            if rung == "model" and i["llm"] and i["llm"]["ok"]:
                opened = i["llm"]["verdict"] == "open"
                service = i["llm"]["service"] or service
        if not opened:
            continue
        key = (i["service"], i["sensor"])
        if key in seen:
            continue
        seen.add(key)
        out.append({"at": at, "service": service})
    return out


def case_outcome(c, row: dict, rung: str) -> dict:
    r = row["result"]
    if r is None:  # a failed run is a miss with no false issues recorded
        return {
            "failed": True,
            "censored": False,
            "any": False,
            "correct": False,
            "delay": None,
            "false": 0,
            "pre_hours": 0.0,
            "issues": 0,
        }
    warm = r["config"]["warmupSeconds"]
    monitored_from = r["start"] + warm
    pre_hours = max(0.0, (c.inject_time - monitored_from) / 3600)
    iss = issues(r, rung)
    pre = [x for x in iss if x["at"] < c.inject_time]
    window = [x for x in iss if c.inject_time <= x["at"] <= c.inject_time + WINDOW]
    censored = r["end"] < c.inject_time + WINDOW
    first = window[0] if window else None
    return {
        "failed": False,
        "censored": censored,
        "any": first is not None,
        "correct": first is not None and first["service"] == c.root_cause_service,
        "delay": None if first is None else first["at"] - c.inject_time,
        "false": len(pre),
        "pre_hours": pre_hours,
        "issues": len(iss),
    }


def summarize(outs: list[dict], scenario_of: list[str], seed: int = 0) -> dict:
    scored = [(o, s) for o, s in zip(outs, scenario_of, strict=True) if not o["censored"]]
    n = len(scored)
    rec_any = sum(o["any"] for o, _ in scored) / n if n else 0.0
    rec_cor = sum(o["correct"] for o, _ in scored) / n if n else 0.0
    delays = [o["delay"] for o, _ in scored if o["delay"] is not None]
    hours = sum(o["pre_hours"] for o in outs)
    false = sum(o["false"] for o in outs)

    def boot(stat):
        by: dict[str, list[dict]] = defaultdict(list)
        for o, s in scored:
            by[s].append(o)
        keys = list(by)
        rng = random.Random(seed)
        vals = []
        for _ in range(2000):
            draw = [o for k in rng.choices(keys, k=len(keys)) for o in by[k]]
            vals.append(stat(draw))
        vals.sort()
        return [round(vals[int(0.025 * 1999)], 3), round(vals[int(0.975 * 1999)], 3)]

    return {
        "cases": len(outs),
        "censored": sum(o["censored"] for o in outs),
        "failed": sum(o["failed"] for o in outs),
        "recall_any": round(rec_any, 3),
        "recall_any_ci": boot(lambda d: sum(o["any"] for o in d) / len(d)),
        "recall_correct": round(rec_cor, 3),
        "recall_correct_ci": boot(lambda d: sum(o["correct"] for o in d) / len(d)),
        "median_delay_s": statistics.median(delays) if delays else None,
        "false_issues": false,
        "monitored_hours_before_injection": round(hours, 2),
        "false_issues_per_hour": round(false / hours, 2) if hours else None,
        "issues_per_case": round(sum(o["issues"] for o in outs) / len(outs), 2),
    }


def score(split: str) -> dict:
    split_cases = cases(split)
    rows = {
        json.loads(line)["case"]: json.loads(line)
        for line in (RESULTS / "q3" / split / "watch.jsonl").read_text().splitlines()
    }
    missing = [c.case for c in split_cases if c.case not in rows]
    if missing:
        raise SystemExit(
            f"SIFT-E104 Q3 has no outcome for {len(missing)} cases of {split} (first: {missing[0]})\nfix: rerun run_q3 on {split}"
        )
    scen = [c.scenario for c in split_cases]
    out: dict = {"split": split, "window_seconds": WINDOW, "rungs": {}, "by_fault": {}, "model": {}}
    for rung in RUNGS:
        outs = [case_outcome(c, rows[c.case], rung) for c in split_cases]
        out["rungs"][rung] = summarize(outs, scen)
        for fault in sorted({c.fault for c in split_cases}):
            idx = [i for i, c in enumerate(split_cases) if c.fault == fault]
            out["by_fault"].setdefault(fault, {})[rung] = summarize(
                [outs[i] for i in idx], [scen[i] for i in idx]
            )
    # model behaviour across every call it made
    calls = [
        i["llm"] for r in rows.values() if r["result"] for i in r["result"]["investigations"] if i["llm"]
    ]
    gate_passed = sum(
        1 for r in rows.values() if r["result"] for i in r["result"]["investigations"] if i["gate"]["pass"]
    )
    failures = Counter(c["failure"] for c in calls)
    ok = [c for c in calls if c["ok"]]
    out["model"] = {
        "name": next((r["result"]["model"] for r in rows.values() if r["result"]), None),
        "gate_passed_signals": gate_passed,
        "calls": len(calls),
        "skipped_by_cap": sum(
            1
            for r in rows.values()
            if r["result"]
            for i in r["result"]["investigations"]
            if i["llmSkipped"] == "cap"
        ),
        "usable_answers": len(ok),
        "failures": dict(failures),
        "open_share": round(sum(c["verdict"] == "open" for c in ok) / len(ok), 3) if ok else None,
        "renamed_service_share": round(
            sum(
                1
                for r in rows.values()
                if r["result"]
                for i in r["result"]["investigations"]
                if i["llm"] and i["llm"]["ok"] and i["llm"]["service"] != i["service"]
            )
            / len(ok),
            3,
        )
        if ok
        else None,
        "median_latency_ms": statistics.median(c["latencyMs"] for c in calls) if calls else None,
        "median_input_tokens": statistics.median(c["inputTokens"] for c in calls) if calls else None,
        "median_output_tokens": statistics.median(c["outputTokens"] for c in calls) if calls else None,
    }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True)
    args = ap.parse_args()
    out = score(args.split)
    dump(RESULTS / "q3" / args.split / "summary.json", out)
    print(
        f"{'rung':6} {'recall(any)':>12} {'recall(correct)':>16} {'delay':>6} {'false/h':>8} {'issues/case':>12}"
    )
    for rung, s in out["rungs"].items():
        print(
            f"{rung:6} {s['recall_any']:6.3f} {str(s['recall_any_ci']):>13} {s['recall_correct']:6.3f} {str(s['recall_correct_ci']):>13} "
            f"{s['median_delay_s']!s:>6} {s['false_issues_per_hour']!s:>8} {s['issues_per_case']:>8}"
        )
    print("model:", json.dumps(out["model"]))


if __name__ == "__main__":
    main()
