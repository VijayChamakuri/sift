"""Build the GitHub Pages site (site/index.html) from the same values and tables as the README.

Nothing on the page is typed by hand: report.py passes its values and Markdown tables here, so the
page and the README never disagree. Styling is shared with the TrustGate, CommitCompass and
JudgeGate pages so the four read as one body of work.
"""

from __future__ import annotations

import html
import re
import shutil
from pathlib import Path

from .data import ROOT

SITE = ROOT / "site"
REPO_URL = "https://github.com/VijayChamakuri/sift"
FIGURES = ("by_fault.png", "ablation.png")


def inline(s: str) -> str:
    s = html.escape(s, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)


def md_table(md: str) -> str:
    """A Markdown pipe table (as report.py writes them) as an HTML table; trailing prose becomes a caption line."""
    lines = [ln for ln in md.strip().splitlines() if ln.strip()]
    rows = [ln for ln in lines if ln.startswith("|")]
    tail = [ln for ln in lines if not ln.startswith("|")]
    head = [c.strip() for c in rows[0].strip("|").split("|")]
    align = [c.strip().endswith(":") for c in rows[1].strip("|").split("|")]
    th = "".join(f"<th{' class=n' if a else ''}>{inline(c)}</th>" for c, a in zip(head, align, strict=True))
    body = ""
    for r in rows[2:]:
        cells = [c.strip() for c in r.strip("|").split("|")]
        body += (
            "<tr>"
            + "".join(
                f"<td{' class=n' if a else ''}>{inline(c)}</td>" for c, a in zip(cells, align, strict=True)
            )
            + "</tr>"
        )
    after = "".join(f"<p>{inline(t)}</p>" for t in tail)
    return f"<div class=scroll><table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table></div>{after}"


def build(values: dict[str, str], figures_dir: Path) -> Path:
    SITE.mkdir(exist_ok=True)
    for f in FIGURES:
        shutil.copy(figures_dir / f, SITE / f)
    page = TEMPLATE
    tables = {
        k: md_table(v) for k, v in values.items() if k.endswith("_table") and v.lstrip().startswith("|")
    }
    for k, v in {
        **{k: html.escape(x) for k, x in values.items()},
        **tables,
        "css": CSS,
        "repo": REPO_URL,
    }.items():
        page = page.replace("{{" + k + "}}", v)
    missing = re.findall(r"\{\{(\w+)\}\}", page)
    if missing:
        raise SystemExit(
            f"SIFT-E104 unfilled placeholders in the site template: {missing}\nfix: add them in report.py"
        )
    out = SITE / "index.html"
    out.write_text(page)
    (SITE / ".nojekyll").write_text("")
    return out


# Shared with the TrustGate, CommitCompass and JudgeGate pages.
CSS = """
:root{--paper:#ffffff;--ink:#1c1b19;--ink2:#47443e;--muted:#77736a;--rule:#d9d3c6;--rule2:#ebe6db;--link:#1a4c8c;--flag:#a3261b;--code:#f2eee3}
html{color-scheme:light}*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:18px/1.62 Charter,"Bitstream Charter","Iowan Old Style","Sitka Text",Cambria,Georgia,serif;-webkit-text-size-adjust:100%}
.page{max-width:700px;margin:0 auto;padding:20px 20px 96px}
.top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 24px;padding-bottom:12px;margin-bottom:56px;border-bottom:1px solid var(--rule);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:var(--muted)}
.top a{color:var(--ink2);text-decoration:none}.top a:hover{color:var(--link);text-decoration:underline}
.top nav{display:flex;flex-wrap:wrap;gap:4px 18px}.top nav span{color:var(--ink);font-weight:600}
h1{font-size:clamp(28px,5.4vw,38px);line-height:1.18;letter-spacing:-.01em;margin:0 0 14px}
.meta{font-style:italic;color:var(--muted);font-size:16px;margin:0 0 40px}
h2{font-size:24px;line-height:1.3;margin:60px 0 12px}
p{margin:0 0 18px}ol,ul{margin:0 0 18px;padding-left:26px}li{margin:0 0 12px}li::marker{color:var(--muted)}
a{color:var(--link);text-decoration-thickness:1px;text-underline-offset:3px}
code{font:.8em ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:var(--code);padding:2px 4px;border-radius:3px}
pre{font:14px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:var(--code);padding:12px 14px;border-radius:4px;overflow-x:auto}
pre code{background:none;padding:0;font-size:inherit}
.wide{position:relative;left:50%;transform:translateX(-50%);width:min(1000px,calc(100vw - 40px))}
figure{margin:36px 0}figure.narrow img{max-width:560px}figure img{display:block;width:100%;height:auto;margin:0 auto}
figcaption,.cap{font-size:15.5px;line-height:1.5;color:var(--ink2);max-width:700px;margin:12px auto 0}
.cap{margin:0 auto 10px}figcaption b,.cap b{color:var(--ink)}
.tbl{margin:32px 0}.scroll{overflow-x:auto}
.tbl.wide{width:fit-content;min-width:min(700px,calc(100vw - 40px));max-width:min(1000px,calc(100vw - 40px))}.cap{contain:inline-size}
.tbl p{font-size:15.5px;color:var(--ink2);margin:10px 0 0}
table{border-collapse:collapse;width:100%;font:13.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-variant-numeric:tabular-nums;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink)}
th{font-weight:600;text-align:left;vertical-align:bottom;padding:8px 10px;border-bottom:1px solid var(--ink)}
td{padding:6px 10px;border-bottom:1px solid var(--rule2);vertical-align:top}tr:last-child td{border-bottom:0}
.n{text-align:right;white-space:nowrap}th.n{white-space:normal;min-width:5em}td:first-child{min-width:11em}.dim{color:var(--muted)}.flag{color:var(--flag);font-weight:600}
footer{margin-top:80px;padding-top:14px;border-top:1px solid var(--rule);font-size:15px;color:var(--muted)}
@media (max-width:600px){body{font-size:17px}.top{margin-bottom:36px}h2{margin-top:48px}}
"""

TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sift</title>
<meta name="description" content="Can an agent find the broken service from logs alone? A logs-only observability engine and a pre-registered test on injected microservice faults.">
<style>{{css}}</style></head><body><div class=page>
<header class=top><a href="https://github.com/VijayChamakuri">Vijay Chamakuri</a>
<nav><a href="https://vijaychamakuri.github.io/trustgate/">TrustGate</a><a href="https://vijaychamakuri.github.io/commitcompass/">CommitCompass</a><a href="https://vijaychamakuri.github.io/judgegate/">JudgeGate</a><span>Sift</span></nav></header>
<main>
<h1>Can an agent find the broken service from logs alone?</h1>
<p class=meta>Vijay Chamakuri, November 2026. Code, data and full method on <a href="{{repo}}">GitHub</a>.</p>

<p>Some observability products are betting that logs are enough: metrics and traces can be derived from them,
and an agent reading them can find what broke. I built a small version of that path, an engine that takes
OpenTelemetry logs, writes them durably, mines templates as they arrive, stores them in Parquet and ranks the
services most likely to be the root cause, and then tested the bet on public benchmark data with known answers.</p>
<p>The data is RCAEval, a benchmark of faults injected into real microservice applications, where the faulty
service is known for every case. I designed and tuned everything on one application (Online Boutique), wrote down
seven predictions, committed them, and only then opened a second application (Sock Shop), once.</p>

<h2>What I found</h2>
<p>On Online Boutique, Sift reached Avg@5 {{dev_sift_avg5}} from logs alone, against {{dev_logs_avg5}} for the published
multi-source method given the same logs. On Sock Shop the frozen configuration reached <strong>{{sift_avg5}}</strong>
(AC@1 {{sift_ac1}}) and ranked <code>{{sift_top1_service}}</code> first in {{sift_top1_share}} of cases. The published
method on the same logs reached {{logs_baro_avg5}}; given metrics, {{metrics_baro_avg5}}. The paired difference,
Sift minus that method on logs, is {{paired_diff}} (95% interval {{paired_ci}}). {{predictions_held}} of the seven
predictions held.</p>
<p>The cause is specific. Sift counts every template it has never seen before as evidence. Sock Shop's front-end
writes new, one-off lines all the time, faults or not; Online Boutique's services rarely do. The fix is to score a
service's new templates against its own rate before the alarm. It will be pre-registered and tested once on a third
application nobody has looked at yet.</p>

<div class="tbl wide"><p class=cap><b>Table 1.</b> {{head_label}}, {{head_cases}} cases. Avg@5 is the mean of AC@1 to AC@5;
a random ranking over the same candidates scores {{chance_avg5}}. Intervals are 95% paired cluster bootstraps over
(service, fault) scenarios; a failed run counts as a miss.</p>{{head_table}}</div>

<figure class=wide><img src="by_fault.png" alt="Avg@5 by fault type for Sift, the published method on logs only and the published method on metrics only.">
<figcaption><b>Figure 1.</b> By fault type. Logs see code-level faults and packet loss; they say little about CPU,
memory and disk pressure, where metrics do far better.</figcaption></figure>

<h2>The predictions, checked</h2>
<div class="tbl wide">{{predictions_table}}</div>

<h2>What logs carry</h2>
<p>To separate "what the signal holds" from "how good the method is", the published method is run unchanged with
only its input varied. On Online Boutique the logs-only variant was at chance ({{dev_logs_lift}} above a random
ranking); on Sock Shop it is clearly above it ({{logs_baro_lift}}). What logs carry depends on how a system logs.</p>
<figure class=narrow><img src="ablation.png" alt="Avg@5 of the same method given metrics only, traces only, logs only and all signals.">
<figcaption><b>Figure 2.</b> Same method, different signals. Sock Shop has no traces, so its traces-only run
ranks nothing and scores as a random ranking.</figcaption></figure>

<h2>A check every method gets</h2>
<p>A method that names the same service first in most cases looks accurate whenever that service is the answer.
The metric-based baseline names a datastore first in most cases, and that datastore is never the answer; Sift's
failure on Sock Shop is the same pattern. The table shows it for every method.</p>
<div class="tbl wide">{{concentration_table}}</div>

<h2>The engine</h2>
<p>Logs arrive over OTLP/HTTP and are acknowledged only after an fsync of the write-ahead log. Templates are mined
online per service and versioned, so every stored line rebuilds byte for byte. Parquet segments, rollups and the
template registry are committed together by one atomic manifest, and anything after it is replayed from the log on
restart.</p>
<div class="tbl wide"><p class=cap><b>Table 2.</b> Crash test: kill the server under load at random moments and at
each commit step, restart, resend batches whose outcome is unknown, then check every acknowledged record.
Running the same test with recovery deliberately broken lost {{sens_lost}} of {{sens_acked}} records, so the test can
see a failure.</p>
<div class=scroll><table><tbody>
<tr><td>Crash runs</td><td class=n>{{crash_runs}}</td></tr>
<tr><td>Acknowledged records</td><td class=n>{{crash_records}}</td></tr>
<tr><td>Lost</td><td class=n><strong>{{crash_lost}}</strong></td></tr>
<tr><td>Duplicated</td><td class=n><strong>{{crash_dup}}</strong></td></tr>
<tr><td>OTLP/HTTP throughput, 8 senders</td><td class=n>{{tp_http}} records/s</td></tr>
<tr><td>Ack latency per 1,000-record batch</td><td class=n>p50 {{tp_p50}} ms, p99 {{tp_p99}} ms</td></tr>
<tr><td>Machine</td><td class=n>{{machine}}</td></tr>
</tbody></table></div></div>
<p>The durability claim is for a process crash: power loss on macOS would also need <code>F_FULLFSYNC</code> and is
not claimed. To try it: <code>pnpm install &amp;&amp; pnpm demo</code> replays one real incident through the whole path
in about ten seconds, with no Docker, no download and no model.</p>
<p>The design decisions and their costs, the interfaces, and how this would grow past one node are in the
<a href="{{repo}}#design-decisions-and-trade-offs">README</a>.</p>

<h2>What's next</h2>
<ul>
<li>Sift v2, pre-registered before the third application is opened: new templates scored against the service's own
rate before the alarm.</li>
<li>Investigate before alert: sensors fire, a deterministic gate re-measures, a local model decides whether to open an
issue, on forward-only replay with no access to the injection time.</li>
<li>Cost: lossless compression and query cost on Loghub-2.0 against gzip, zstd, ClickHouse and CLP.</li>
</ul>

<footer><p>Every number on this page is generated from committed per-case outputs; CI regenerates it and fails if
anything changes. The configuration and predictions were committed before the test set was read:
<a href="{{repo}}/blob/main/PREREGISTRATION.md">PREREGISTRATION.md</a>.</p>
<p>Code: MIT licence. Data: RCAEval (Pham et al., WWW 2025), MIT licence. OpenTelemetry protocol definitions: Apache-2.0.</p></footer>
</main></div></body></html>
"""
