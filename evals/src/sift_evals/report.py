"""Regenerate README.md, its figures and every published number from committed results.

Inputs: results/q1/<split>/*.jsonl (per-case outputs), results/infra/*.json, results/audit/audit.json,
results/q1/dev/tuning.json. Nothing in the README is typed by hand: CI runs this and fails if the
output differs from what is committed.

Run: uv run --project evals python -m sift_evals.report
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import matplotlib.pyplot as plt

from . import chartstyle as cs
from .data import RESULTS, ROOT, dump
from .score_q1 import score_split

FIG = ROOT / "docs" / "figures"
TEMPLATE = ROOT / "docs" / "README.template.md"
NAMES = {
    "sift": "Sift (logs)",
    "sift_v2": "Sift v2 (logs)",
    "control:error-surge": "Error-surge control (logs)",
    "mmbaro:logs": "Multi-source BARO, logs only",
    "mmbaro:traces": "Multi-source BARO, traces only",
    "mmbaro:metrics": "Multi-source BARO, metrics only",
    "mmbaro:all": "Multi-source BARO, all signals",
    "baro": "BARO (metrics)",
}
ORDER = list(NAMES)
FAULT_GROUPS = [
    ("code-level (RE3)", {"f1", "f2", "f3", "f4", "f5"}),
    ("loss", {"loss"}),
    ("socket", {"socket"}),
    ("delay", {"delay"}),
    ("cpu", {"cpu"}),
    ("mem", {"mem"}),
    ("disk", {"disk"}),
]


def f3(x: float) -> str:
    return f"{x:.3f}"


def ci(c: list[float] | tuple[float, float]) -> str:
    return f"[{c[0]:.2f}, {c[1]:.2f}]"


def method_table(summary: dict, methods: list[str]) -> str:
    rows = [
        "| Method | Signal | AC@1 | AC@3 | Avg@5 | 95% CI | Lift over chance | Failed |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for m in methods:
        if m not in summary["methods"]:
            continue  # e.g. Sift v2 has not been run on this split
        s = summary["methods"][m]
        signal = (
            "logs"
            if m in ("sift", "sift_v2", "control:error-surge", "mmbaro:logs")
            else m.split(":")[-1]
            if ":" in m
            else "metrics"
        )
        name = f"**{NAMES[m]}**" if m == "sift" else NAMES[m]
        rows.append(
            f"| {name} | {signal} | {f3(s['ac1'])} | {f3(s['ac3'])} | {f3(s['avg5'])} | {ci(s['avg5_ci'])} | {s['lift5']:+.3f} | {s['failed']} |"
        )
    return "\n".join(rows)


def grouped_faults(summary: dict) -> dict[str, dict[str, float]]:
    """Avg@5 per fault group, weighting each fault by its case count."""
    out: dict[str, dict[str, float]] = {}
    for label, faults in FAULT_GROUPS:
        per = [summary["by_fault"][f] for f in faults if f in summary["by_fault"]]
        if not per:
            continue
        n = sum(p["sift"]["cases"] for p in per)
        out[label] = {m: sum(p[m]["avg5"] * p[m]["cases"] for p in per) / n for m in ORDER if m in per[0]}
        out[label]["cases"] = n
    return out


def fault_table(groups: dict[str, dict[str, float]]) -> str:
    cols = ["sift", "mmbaro:logs", "control:error-surge", "mmbaro:metrics", "mmbaro:traces"]
    rows = [
        "| Fault | Cases | " + " | ".join(NAMES[c] for c in cols) + " |",
        "|---|---:|" + "---:|" * len(cols),
    ]
    for label, g in groups.items():
        rows.append(f"| {label} | {int(g['cases'])} | " + " | ".join(f3(g[c]) for c in cols) + " |")
    return "\n".join(rows)


def fault_chart(groups: dict[str, dict[str, float]], title: str, path: Path) -> None:
    cs.apply()
    fig, ax = plt.subplots(figsize=(7.4, 3.6))
    labels = list(groups)
    series = [
        ("sift", "Sift (logs)", cs.BLUE),
        ("mmbaro:logs", "BARO, logs only", cs.ORANGE),
        ("mmbaro:metrics", "BARO, metrics only", cs.NEUTRAL),
    ]
    w = 0.26
    for i, (m, name, colour) in enumerate(series):
        xs = [k + (i - 1) * w for k in range(len(labels))]
        ax.bar(xs, [groups[g][m] for g in labels], width=w - 0.03, color=colour, label=name)
    ax.set_xticks(range(len(labels)), labels)
    ax.tick_params(axis="x", length=0)
    ax.set_ylim(0, 1.05)
    ax.set_ylabel("Avg@5")
    ax.set_title(title)
    ax.legend(loc="upper right", ncol=3, frameon=False)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def ablation_chart(summary: dict, title: str, path: Path) -> None:
    cs.apply()
    fig, ax = plt.subplots(figsize=(6.4, 2.6))
    ms = ["mmbaro:metrics", "mmbaro:traces", "mmbaro:logs", "mmbaro:all"]
    labels = ["metrics only", "traces only", "logs only", "all signals"]
    vals = [summary["methods"][m]["avg5"] for m in ms]
    ax.barh(range(len(ms)), vals, color=[cs.NEUTRAL, cs.NEUTRAL, cs.ORANGE, cs.NEUTRAL], height=0.6)
    chance = summary["methods"]["mmbaro:logs"]["chance_avg5"]
    ax.axvline(chance, color=cs.INK2, lw=0.9, ls=":")
    ax.set_ylim(len(ms) - 0.1, -0.5)
    ax.text(chance, len(ms) - 0.2, " random ranking", fontsize=8, color=cs.INK2, va="bottom")
    for i, v in enumerate(vals):
        ax.annotate(
            f"{v:.2f}",
            (v, i),
            xytext=(4, 0),
            textcoords="offset points",
            va="center",
            fontsize=8.5,
            color=cs.INK2,
        )
    ax.set_yticks(range(len(ms)), labels)
    ax.set_xlim(0, 1)
    ax.set_xlabel("Avg@5")
    ax.set_title(title)
    ax.grid(axis="y", visible=False)
    ax.grid(axis="x")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


RUNG_NAMES = {"raw": "Raw sensors", "gate": "+ deterministic gate", "model": "+ local model"}


def q3_table(q3: dict) -> str:
    rows = [
        "| Rung | Detected, any service | Detected, right service | Median delay | False issues per hour | Issues per case |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for rung in RUNG_NAMES:  # ladder order, not the JSON key order
        s = q3["rungs"][rung]
        delay = "–" if s["median_delay_s"] is None else f"{s['median_delay_s']:.0f} s"
        rows.append(
            f"| {RUNG_NAMES[rung]} | {f3(s['recall_any'])} {ci(s['recall_any_ci'])} | {f3(s['recall_correct'])} {ci(s['recall_correct_ci'])} "
            f"| {delay} | {s['false_issues_per_hour']} | {s['issues_per_case']} |"
        )
    return "\n".join(rows)


def concentration_table(summary: dict) -> str:
    rows = [
        "| Method | Most often ranked first | Share of cases ranked first | Share of cases it is the answer |",
        "|---|---|---:|---:|",
    ]
    for m in ORDER:
        t = summary["top1_concentration"].get(m)
        if t:
            rows.append(
                f"| {NAMES[m]} | `{t['most_ranked_first']}` | {t['share_ranked_first']:.2f} | {t['share_as_answer']:.2f} |"
            )
    return "\n".join(rows)


def predictions_table(test: dict, dev: dict) -> str:
    """The predictions in PREREGISTRATION.md, each checked mechanically against the test set."""
    s, ml = test["methods"]["sift"], test["methods"]["mmbaro:logs"]
    g = grouped_faults(test)
    strong = (g["code-level (RE3)"]["sift"] + g["loss"]["sift"]) / 2
    weak = (g["cpu"]["sift"] + g["mem"]["sift"] + g["disk"]["sift"]) / 3
    ev = test.get("sift_top1_evidence", {})
    hits = sum(ev.values())
    restart = ev.get("restart or redeploy", 0)
    pd = test["paired"]["sift - mmbaro:logs"]
    lo, hi = ml["avg5_ci"]
    checks = [
        (
            "Logs-only multi-source BARO stays near chance (chance inside its 95% CI)",
            lo <= ml["chance_avg5"] <= hi,
            f"Avg@5 {f3(ml['avg5'])} {ci(ml['avg5_ci'])}, chance {f3(ml['chance_avg5'])}",
        ),
        (
            "Sift beats logs-only multi-source BARO (paired 95% CI above zero)",
            pd["lo"] > 0,
            f"difference {pd['mean']:+.3f} {ci((pd['lo'], pd['hi']))}",
        ),
        (
            "Sift stays below metric-based BARO on Avg@5",
            s["avg5"] < test["methods"]["baro"]["avg5"],
            f"{f3(s['avg5'])} vs {f3(test['methods']['baro']['avg5'])}",
        ),
        (
            "Sift's AC@1 is at least metric-based BARO's",
            s["ac1"] >= test["methods"]["baro"]["ac1"],
            f"{f3(s['ac1'])} vs {f3(test['methods']['baro']['ac1'])}",
        ),
        (
            "Sift is stronger on code-level and LOSS than on CPU, MEM, DISK",
            strong > weak,
            f"{f3(strong)} vs {f3(weak)} (mean Avg@5)",
        ),
        (
            "Most of Sift's correct top-1 picks rest on restart or redeploy evidence",
            hits > 0 and restart / hits > 0.5,
            f"{restart} of {hits}",
        ),
        (
            "Sift's test Avg@5 is below its Dev Avg@5",
            s["avg5"] < dev["methods"]["sift"]["avg5"],
            f"{f3(s['avg5'])} vs {f3(dev['methods']['sift']['avg5'])}",
        ),
    ]
    rows = ["| Prediction (committed before the test set was read) | Outcome | Evidence |", "|---|---|---|"]
    rows += [f"| {p} | {'held' if ok else '**failed**'} | {e} |" for p, ok, e in checks]
    held = sum(ok for _, ok, _ in checks)
    return "\n".join(rows) + f"\n\n{held} of {len(checks)} predictions held."


def test_b_checks(tb: dict, q3b: dict) -> list[tuple[str, bool, str]]:
    """The seven predictions of the PREREGISTRATION addendum, checked mechanically on Test B."""
    v1, v2, baro = tb["methods"]["sift"], tb["methods"]["sift_v2"], tb["methods"]["baro"]
    p21, p2l = tb["paired"]["sift_v2 - sift"], tb["paired"]["sift_v2 - mmbaro:logs"]
    top1 = tb["top1_concentration"]["sift_v2"]
    raw, gate_, mdl = (q3b["rungs"][r] for r in ("raw", "gate", "model"))
    cut = (
        raw["false_issues_per_hour"] / gate_["false_issues_per_hour"]
        if gate_["false_issues_per_hour"]
        else float("inf")
    )
    loss = raw["recall_any"] - gate_["recall_any"]
    gap = mdl["recall_correct"] - gate_["recall_correct"]
    opens = q3b["model"]["open_share"]
    return [
        (
            "Sift v2 beats Sift v1 on Avg@5 (paired 95% CI above zero)",
            p21["lo"] > 0,
            f"{f3(v2['avg5'])} vs {f3(v1['avg5'])}, difference {p21['mean']:+.3f} {ci((p21['lo'], p21['hi']))}",
        ),
        (
            "Sift v2 ranks no single service first in more than half of the cases",
            top1["share_ranked_first"] <= 0.5,
            f"`{top1['most_ranked_first']}` first in {top1['share_ranked_first']:.0%}",
        ),
        (
            "Sift v2 stays below metric-based BARO on Avg@5",
            v2["avg5"] < baro["avg5"],
            f"{f3(v2['avg5'])} vs {f3(baro['avg5'])}",
        ),
        (
            "Sift v2 beats logs-only multi-source BARO (paired 95% CI above zero)",
            p2l["lo"] > 0,
            f"difference {p2l['mean']:+.3f} {ci((p2l['lo'], p2l['hi']))}",
        ),
        (
            "The gate cuts false issues per hour at least five-fold and loses at most 0.05 of any-service recall",
            cut >= 5 and loss <= 0.05,
            f"{raw['false_issues_per_hour']} to {gate_['false_issues_per_hour']} per hour ({cut:.1f}-fold); "
            f"recall {f3(raw['recall_any'])} to {f3(gate_['recall_any'])}",
        ),
        (
            "The model rung's right-service recall is within 0.05 of the gate's",
            abs(gap) <= 0.05,
            f"{f3(mdl['recall_correct'])} vs {f3(gate_['recall_correct'])} ({gap:+.3f})",
        ),
        (
            'The model answers "open" to at least 90% of the gate-passed signals it sees',
            opens >= 0.9,
            f"{opens:.1%} of {q3b['model']['calls']} calls",
        ),
    ]


def checks_table(checks: list[tuple[str, bool, str]], heading: str) -> str:
    rows = [f"| {heading} | Outcome | Evidence |", "|---|---|---|"]
    rows += [f"| {p} | {'held' if ok else '**failed**'} | {e} |" for p, ok, e in checks]
    held = sum(ok for _, ok, _ in checks)
    return "\n".join(rows) + f"\n\n{held} of {len(checks)} predictions held."


def evidence_table(summary: dict) -> str:
    ev = summary.get("sift_top1_evidence", {})
    if not ev:
        return "Sift ranked the answer first in no case."
    rows = ["| Evidence behind a correct top-1 pick | Cases |", "|---|---:|"]
    rows += [f"| {k} | {v} |" for k, v in sorted(ev.items(), key=lambda kv: -kv[1])]
    return "\n".join(rows)


def render(template: str, values: dict[str, str]) -> str:
    missing = sorted(set(re.findall(r"{{(\w+)}}", template)) - set(values))
    if missing:
        raise SystemExit(
            f"SIFT-E104 README template uses values that the report does not produce: {missing}\nfix: add them in report.py"
        )
    return re.sub(r"{{(\w+)}}", lambda m: values[m.group(1)], template)


def main() -> None:
    FIG.mkdir(parents=True, exist_ok=True)
    splits = [s for s in ("dev", "test_a", "test_b") if (RESULTS / "q1" / s / "sift.jsonl").exists()]
    summaries = {s: score_split(s) for s in splits}
    for s, summ in summaries.items():
        dump(RESULTS / "q1" / s / "summary.json", summ)
    head = "test_a" if "test_a" in summaries else "dev"
    hs = summaries[head]
    dev = summaries["dev"]
    head_label = {
        "dev": "Dev (design set, optimistic)",
        "test_a": "Test A (Sock Shop, opened once)",
        "test_b": "Test B",
    }[head]
    groups = grouped_faults(hs)
    fault_chart(groups, f"Avg@5 by fault type, {head_label}", FIG / "by_fault.png")
    ablation_chart(
        hs, f"Same method (multi-source BARO), different signals, {head_label}", FIG / "ablation.png"
    )

    crash = json.loads((RESULTS / "infra" / "crash.json").read_text())
    sens = json.loads((RESULTS / "infra" / "crash_sensitivity.json").read_text())
    q3 = json.loads((RESULTS / "q3" / "dev" / "summary.json").read_text())
    durable = json.loads((RESULTS / "infra" / "durable.json").read_text())
    collector = json.loads((RESULTS / "infra" / "collector.json").read_text())
    v1repro = json.loads((RESULTS / "q1" / "dev" / "v1_reproduction.json").read_text())
    tuning_v2 = json.loads((RESULTS / "q1" / "dev" / "tuning_v2.json").read_text())
    tp_path = RESULTS / "infra" / "throughput.json"
    tp = json.loads(tp_path.read_text()) if tp_path.exists() else None
    audit = json.loads((RESULTS / "audit" / "audit.json").read_text())
    tuning = json.loads((RESULTS / "q1" / "dev" / "tuning.json").read_text())
    pdiff = hs["paired"]["sift - mmbaro:logs"]
    s, ml, mm = hs["methods"]["sift"], hs["methods"]["mmbaro:logs"], hs["methods"]["mmbaro:metrics"]
    preds = predictions_table(hs, dev) if head != "dev" else "Test A not run yet."
    top1 = hs["top1_concentration"]["sift"]
    model = q3["model"]
    raw, gate_, mdl = q3["rungs"]["raw"], q3["rungs"]["gate"], q3["rungs"]["model"]
    values = {
        "q3_table": q3_table(q3),
        "q3_false_raw": str(raw["false_issues_per_hour"]),
        "q3_false_gate": str(gate_["false_issues_per_hour"]),
        "q3_false_cut": f"{raw['false_issues_per_hour'] / gate_['false_issues_per_hour']:.0f}"
        if gate_["false_issues_per_hour"]
        else "–",
        "q3_recall_any": f3(gate_["recall_any"]),
        "q3_recall_correct_gate": f3(gate_["recall_correct"]),
        "q3_recall_correct_model": f3(mdl["recall_correct"]),
        "q3_model": str(model["name"]),
        "q3_calls": str(model["calls"]),
        "q3_open_share": f"{model['open_share']:.1%}",
        "q3_renamed": f"{model['renamed_service_share']:.1%}",
        "q3_usable": f"{model['usable_answers']} of {model['calls']}",
        "q3_latency": f"{model['median_latency_ms'] / 1000:.1f} s",
        "q3_tokens_in": f"{model['median_input_tokens']:.0f}",
        "q3_tokens_out": f"{model['median_output_tokens']:.0f}",
        "durable_summary": "; ".join(
            f"killed at `{r['crashPoint'].split('.')[-1]}`: {r['workflowsCompleted']} of {r['workflows']} workflows completed, "
            f"{r['issueRows']} issues for {r['openDecisions']} opened names, {r['duplicateIssues']} duplicated"
            for r in durable["results"]
        ),
        "collector_image": collector["collector"],
        "collector_lines": f"{collector['linesWritten']:,}",
        "collector_received": f"{collector['recordsReceived']:,}",
        "collector_missing": str(collector["missing"]),
        "collector_dup": str(collector["duplicated"]),
        "collector_trimmed": str(collector["linesTrimmedByCollector"]),
        "v1_repro": f"{v1repro['rankings_changed']} of {v1repro['rows']}",
        "v2_dev_avg5": f3(dev["methods"]["sift_v2"]["avg5"]) if "sift_v2" in dev["methods"] else "–",
        "v2_dev_ac1": f3(dev["methods"]["sift_v2"]["ac1"]) if "sift_v2" in dev["methods"] else "–",
        "v2_tuning_min": f3(min(t["avg5"] for t in tuning_v2["trials"])),
        "v2_tuning_max": f3(max(t["avg5"] for t in tuning_v2["trials"])),
        "predictions_table": preds,
        "predictions_held": preds.rsplit("\n", 1)[-1].split(" of ")[0] if head != "dev" else "None",
        "sift_top1_service": str(top1["most_ranked_first"]),
        "sift_top1_share": f"{top1['share_ranked_first']:.0%}",
        "dev_sift_avg5": f3(dev["methods"]["sift"]["avg5"]),
        "dev_logs_avg5": f3(dev["methods"]["mmbaro:logs"]["avg5"]),
        "dev_logs_lift": f"{dev['methods']['mmbaro:logs']['lift5']:+.3f}",
        "evidence_table": evidence_table(hs),
        "dev_evidence_table": evidence_table(dev),
        "head_label": head_label,
        "sift_avg5": f3(s["avg5"]),
        "sift_ac1": f3(s["ac1"]),
        "logs_baro_avg5": f3(ml["avg5"]),
        "logs_baro_lift": f"{ml['lift5']:+.3f}",
        "metrics_baro_avg5": f3(mm["avg5"]),
        "metrics_baro_ac1": f3(mm["ac1"]),
        "chance_avg5": f3(s["chance_avg5"]),
        "paired_diff": f"{pdiff['mean']:+.3f}",
        "paired_ci": ci((pdiff["lo"], pdiff["hi"])),
        "head_cases": str(s["cases"]),
        "head_table": method_table(hs, ORDER),
        "dev_table": method_table(dev, ORDER),
        "fault_table": fault_table(groups),
        "concentration_table": concentration_table(hs),
        "dev_concentration_table": concentration_table(dev),
        "crash_runs": str(crash["runs"]),
        "crash_records": f"{crash['recordsAcked']:,}",
        "crash_lost": str(crash["lost"]),
        "crash_dup": str(crash["duplicated"]),
        "crash_random": str(crash["byCrash"]["random"]),
        "crash_points": ", ".join(f"`{k}` ({v})" for k, v in crash["byCrash"].items() if k != "random"),
        "sens_runs": str(sens["runs"]),
        "sens_lost": f"{sens['lost']:,}",
        "sens_acked": f"{sens['recordsAcked']:,}",
        "tp_direct": f"{tp['direct']['recordsPerSec']:,}" if tp else "not measured yet",
        "tp_http": f"{tp['http']['recordsPerSec']:,}" if tp else "not measured yet",
        "tp_p50": str(tp["http"]["ackLatencyMs"]["p50"]) if tp else "-",
        "tp_p99": str(tp["http"]["ackLatencyMs"]["p99"]) if tp else "-",
        "tp_fresh_p99": str(tp["ingestToQueryableMs"]["p99"]) if tp else "-",
        "tp_records": f"{tp['input']['records']:,}" if tp else "-",
        "machine": f"{crash['machine']['cpuModel']}, {crash['machine']['memGB']} GB RAM, Node {crash['machine']['node']}",
        "pc_coverage": audit["splits"]["dev"]["RE2-OB"]["root_cause_cases_with_any_log"][
            "productcatalogservice"
        ],
        "tuning_trials": str(len(tuning["trials"])),
        "tuning_min": f3(min(t["avg5"] for t in tuning["trials"])),
        "tuning_max": f3(max(t["avg5"] for t in tuning["trials"])),
        "tuning_chosen": tuning["chosen"],
    }
    (ROOT / "README.md").write_text(render(TEMPLATE.read_text(), values))
    from .site import build

    build(values, FIG)
    print("README.md and docs/figures regenerated from", ", ".join(splits))


if __name__ == "__main__":
    main()
