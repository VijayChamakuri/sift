# Sift

[![CI](https://img.shields.io/github/actions/workflow/status/VijayChamakuri/sift/ci.yml?branch=main)](https://github.com/VijayChamakuri/sift/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6)
![Python 3.12](https://img.shields.io/badge/Python-3.12-3776AB)

Can logs alone name the service that broke?

I wrote a single-process engine for that (OTLP in, a write-ahead log, online template mining, Parquet, a ranker) and measured it on injected faults from [RCAEval](https://github.com/phamquiluan/RCAEval) (Pham et al., WWW 2025), code pinned at `90b63a46`. Dev is Online Boutique, where I tuned. Test A is Sock Shop. Test B is Train Ticket. I opened each test set once, after [PREREGISTRATION.md](PREREGISTRATION.md) was committed. Test B also required the git tag `q3-frozen`.

Numbers below are filled in by [`evals/src/sift_evals/report.py`](evals/src/sift_evals/report.py) from `results/`. CI runs that script and fails if this file drifts.

## Result

On Train Ticket (120 cases, opened once) Sift v2 reaches Avg@5 **0.403**. BARO on metrics, same cases, reaches **0.853**. v2 minus v1 is +0.055 (95% CI [+0.003, +0.105]). The published method on the same logs reaches 0.343. 6 of the 7 predictions I wrote before opening the set held.

On Sock Shop the frozen v1 config reaches Avg@5 **0.443** (AC@1 0.075) and ranks `front-end` first in 99% of cases. Logs-only multi-source BARO reaches 0.555. Metric BARO reaches 0.770. Paired difference, v1 minus logs-only BARO: -0.112 (95% CI [-0.18, -0.04]). 3 of 7 predictions held. v1 treated every template it had never seen as evidence, and Sock Shop's front-end writes one-off lines whether or not it is the fault. v2 subtracts that service's own new-template mass in the 300 s before the alarm (`noveltyBaseline` in [`configs/rank_v2.json`](configs/rank_v2.json)).

Avg@5 is the mean of AC@1..AC@5, RCAEval's definition, at service level. A random ranking of the same candidates scores 0.044 on Train Ticket and 0.273 on Sock Shop. Intervals are 95% paired cluster bootstraps over (service, fault), 2000 resamples, seed 0. A failed run scores as a miss at every k.

This is one Dev case, not a test-set number. `fixtures/demo/case.json` is `re3ob_adservice_f4_1`: 32,531 lines, fault `f4`, answer `adservice`, alarm `1731905504`. On Linux with Node 24.22.3, after `pnpm install` and `pnpm build`, I ran:

```bash
node engine/dist/surfaces/cli.js rca \
  --logs fixtures/demo/logs.parquet \
  --at 1731905504 \
  --config configs/rank.json
```

It printed `adservice` first (score 28.23), then `recommendationservice` (12.80), then `frontend` (6.10). The same command with `--json` reported `ingestMs` 115, `records` 32531, `templates` 91. `pnpm demo` sends that file through OTLP/HTTP at 60x ([`engine/src/surfaces/demo.ts`](engine/src/surfaces/demo.ts)) and printed `finished in 10.6 s` and `ranked #1`.

### Test B (Train Ticket, opened once)

| Method | Signal | AC@1 | AC@3 | Avg@5 | 95% CI | Lift over chance | Failed |
|---|---|---:|---:|---:|---:|---:|---:|
| **Sift v1 (logs)** | logs | 0.292 | 0.358 | 0.348 | [0.21, 0.49] | +0.304 | 1 |
| Sift v2 (logs) | logs | 0.308 | 0.408 | 0.403 | [0.28, 0.54] | +0.359 | 1 |
| Error-surge control (logs) | logs | 0.075 | 0.167 | 0.194 | [0.12, 0.28] | +0.150 | 1 |
| Multi-source BARO, logs only | logs | 0.275 | 0.359 | 0.343 | [0.21, 0.48] | +0.299 | 1 |
| Multi-source BARO, traces only | traces | 0.492 | 0.867 | 0.797 | [0.73, 0.85] | +0.753 | 0 |
| Multi-source BARO, metrics only | metrics | 0.750 | 0.867 | 0.853 | [0.78, 0.92] | +0.809 | 0 |
| Multi-source BARO, all signals | all | 0.750 | 0.875 | 0.870 | [0.80, 0.93] | +0.826 | 1 |
| BARO (metrics) | metrics | 0.758 | 0.875 | 0.853 | [0.78, 0.92] | +0.809 | 0 |

1 case ships with no `logs.parquet`. Every logs-only method scores it as a miss. RCAEval's own code fails on one other case for two baseline variants. That is a miss too. v1's AC@1 is 0.292 and v2's is 0.308. v1 minus logs-only BARO is +0.005 (95% CI [-0.035, +0.048]).

| Fault | Cases | Sift v1 (logs) | Multi-source BARO, logs only | Error-surge control (logs) | Multi-source BARO, metrics only | Multi-source BARO, traces only |
|---|---:|---:|---:|---:|---:|---:|
| code-level (RE3) | 30 | 1.000 | 0.987 | 0.354 | 0.940 | 0.927 |
| loss | 15 | 0.147 | 0.149 | 0.188 | 0.613 | 0.573 |
| socket | 15 | 0.000 | 0.054 | 0.121 | 0.813 | 0.853 |
| delay | 15 | 0.173 | 0.054 | 0.004 | 0.653 | 0.867 |
| cpu | 15 | 0.240 | 0.231 | 0.227 | 0.880 | 0.840 |
| mem | 15 | 0.227 | 0.175 | 0.093 | 0.987 | 0.693 |
| disk | 15 | 0.000 | 0.109 | 0.213 | 1.000 | 0.693 |

### Test A (Sock Shop, opened once)

| Method | Signal | AC@1 | AC@3 | Avg@5 | 95% CI | Lift over chance | Failed |
|---|---|---:|---:|---:|---:|---:|---:|
| **Sift v1 (logs)** | logs | 0.075 | 0.608 | 0.443 | [0.34, 0.55] | +0.171 | 0 |
| Error-surge control (logs) | logs | 0.166 | 0.511 | 0.456 | [0.37, 0.55] | +0.183 | 0 |
| Multi-source BARO, logs only | logs | 0.308 | 0.592 | 0.555 | [0.44, 0.67] | +0.282 | 0 |
| Multi-source BARO, traces only | traces | 0.091 | 0.273 | 0.273 | [0.27, 0.27] | +0.000 | 0 |
| Multi-source BARO, metrics only | metrics | 0.108 | 0.958 | 0.770 | [0.73, 0.80] | +0.497 | 0 |
| Multi-source BARO, all signals | all | 0.108 | 0.958 | 0.772 | [0.74, 0.81] | +0.499 | 0 |
| BARO (metrics) | metrics | 0.100 | 0.967 | 0.768 | [0.73, 0.80] | +0.496 | 0 |

| Fault | Cases | Sift v1 (logs) | Multi-source BARO, logs only | Error-surge control (logs) | Multi-source BARO, metrics only | Multi-source BARO, traces only |
|---|---:|---:|---:|---:|---:|---:|
| code-level (RE3) | 30 | 0.720 | 0.920 | 0.674 | 0.747 | 0.273 |
| loss | 15 | 0.573 | 0.693 | 0.639 | 0.787 | 0.273 |
| socket | 15 | 0.280 | 0.373 | 0.315 | 0.720 | 0.273 |
| delay | 15 | 0.280 | 0.360 | 0.293 | 0.667 | 0.273 |
| cpu | 15 | 0.280 | 0.320 | 0.225 | 0.800 | 0.273 |
| mem | 15 | 0.320 | 0.480 | 0.498 | 0.880 | 0.273 |
| disk | 15 | 0.373 | 0.373 | 0.332 | 0.813 | 0.273 |

![Avg@5 by fault type, Test A](docs/figures/by_fault.png)

![Multi-source BARO with one signal at a time, Test A](docs/figures/ablation.png)

[`manifests/rcaeval-test_a.json`](manifests/rcaeval-test_a.json) has no `traces.parquet` entries, so the traces-only row matches chance (0.273). Logs-only BARO's lift is +0.282 here and +0.002 on Online Boutique. What the logs carry depends on the system.

| Evidence behind a correct top-1 pick | Cases |
|---|---:|
| other new templates | 9 |

On Dev, most correct top-1 picks were restart or redeploy lines (the injector had restarted a container). On Sock Shop, none were.

## How it works

```mermaid
flowchart LR
  otlp["POST /v1/logs"] --> wal["WAL: fsync, then ack"]
  wal --> mine["Drain, one tree per service"]
  mine --> seg["Parquet segment and minute rollups"]
  seg --> man["rename manifest.json"]
  man --> duck["DuckDB views"]
  duck --> rank["rank()"]
```

A batch is acknowledged only after the `fsync` that covers its frame ([`engine/src/logstore/wal.ts`](engine/src/logstore/wal.ts)). Appends that arrive during that fsync share the next one. The frame is length, CRC32, then UTF-8 JSON. On open, a torn tail is truncated. The id index is rebuilt from the frames, so a retry with the same `x-sift-batch-id` is a duplicate for 10 minutes. An older retry is `SIFT-E105`, not a second write.

The miner is Drain (He et al., ICWS 2017), online, per service ([`engine/src/templates/drain.ts`](engine/src/templates/drain.ts)). Tokens that look like numbers, hex, UUIDs, IPs, or identifiers are masked for matching. When a cluster generalises, it keeps the old token list as a version. `reconstruct` fills that version's `<*>` slots, so the line comes back byte for byte. Past 5,000 clusters per service, or 512 tokens, the line is stored verbatim.

Flush writes a zstd Parquet segment and minute rollups (`ts_ns // 60000000000`), then renames one manifest ([`engine/src/logstore/store.ts`](engine/src/logstore/store.ts)). Recovery loads that manifest and replays the WAL from `walOffset`. Files the manifest does not name are deleted. Queries and the next flush share one lock.

The ranker reads template counts in the 300 s before and after an alarm time `T`. Novelty is templates whose first line is at or after `T`. Surge is an existing error template that grew. Shift is the service's volume against the system-wide trend, as a Poisson z, so a traffic drop everywhere is not evidence. From [`engine/src/detect/rank.ts`](engine/src/detect/rank.ts#L139-L145):

```ts
    const expected = vol.before * trend;
    const z = (vol.after - expected) / Math.sqrt(expected + 1);
    const shift = Math.log1p(Math.abs(z));
    if (Math.abs(z) > 3) evidence.push({ kind: "shift", templateId: null, template: "(all lines)", before: vol.before, after: vol.after, example: null });
    if (cfg.noveltyBaseline) novelty = Math.max(0, novelty - noveltyBefore);
    const score = cfg.wNovelty * novelty + cfg.wSurge * surge + cfg.wShift * shift;
```

Weights live in [`configs/rank.json`](configs/rank.json). I picked them on Dev from 18 logged settings (Avg@5 0.445 to 0.533). The winner was `errorWeight0.5_wShift2_wSurge0.5`, on the edge of the grid. I did not extend the grid. v2's grid is [`results/q1/dev/tuning_v2.json`](results/q1/dev/tuning_v2.json): Dev Avg@5 0.517 to 0.558, chosen config Avg@5 0.558, AC@1 0.392. Re-running v1 on Dev after the v2 flag changed 0 of 240 rankings ([`results/q1/dev/v1_reproduction.json`](results/q1/dev/v1_reproduction.json)).

`sift watch` does not receive the injection time ([`engine/src/detect/watch.ts`](engine/src/detect/watch.ts)). Every 15 s of event time it scores, per service, a Poisson z on line rate and on error rate against that service's own previous 300 s, plus a new error template. The gate in [`engine/src/detect/investigate.ts`](engine/src/detect/investigate.ts) waits 60 s and keeps the signal only if it persists and is not a system-wide shift. A local model (mlx-community/Qwen2.5-3B-Instruct-4bit, Vercel AI SDK, OpenAI-compatible HTTP) sees numbered evidence and must return `{verdict, service, summary, evidence}`. Log text is quoted as data. A bad answer keeps the gate's decision. With `--durable`, that call and the Postgres insert are a Temporal workflow ([`engine/src/durable/workflows.ts`](engine/src/durable/workflows.ts)). One issue per service and sensor per run.

HTTP is [`engine/src/surfaces/server.ts`](engine/src/surfaces/server.ts). It binds `127.0.0.1`. There is no authentication.

| Route or command | What it does |
|---|---|
| `POST /v1/logs` | OTLP/HTTP, protobuf or JSON, identity or gzip. Gzip output is capped at 64 MiB. Body limit 16 MiB. Overload is `429` with `Retry-After`. |
| `POST /query` | SQL over `logs`, `rollups`, `templates`. `"reconstruct": true` adds the original line. |
| `GET /rank?at=<unix s>` | Ranked services and the evidence lines. |
| `GET /healthz` | `walOffset` and pending rows. |
| `sift serve`, `replay`, `rank`, `rca`, `watch`, `worker`, `doctor` | CLI. Every command takes `--json`. `sift rca --help` prints the demo file and alarm `1731905504`. |

## Decisions

I tried a first ranker on Dev and threw it out. [`results/q1/dev/history/tuning_round1.json`](results/q1/dev/history/tuning_round1.json) and the note in [PREREGISTRATION.md](PREREGISTRATION.md): it ranked `recommendationservice` first in 52 of 120 Dev cases and `redis` in 33, because unmasked identifier lists became new templates and the volume term inflated quiet services. The miner now masks those tokens ([`engine/test/drain.test.ts`](engine/test/drain.test.ts)), and the volume term is the Poisson z above. Round 2 is [`results/q1/dev/tuning.json`](results/q1/dev/tuning.json).

| Choice | Why this, in the code | What it costs |
|---|---|---|
| Ack after `fsync`, group commit | An acked batch has to survive `kill -9`. Batching shares the fsync. | Ack latency is at least one fsync. On Apple M2, 8 GB RAM, Node 24.19.0, 1,000-record batches over OTLP: p50 19.8 ms, p99 253.6 ms. |
| WAL is the only source of truth | Segments, rollups, and the template snapshot are derived. Recovery is "load the manifest, replay after `walOffset`". | The unflushed tail is bounded by the 1 s flush. The WAL is not trimmed after commit, so disk keeps a second copy. |
| JSON frames, CRC32 per frame | I wanted to read the log while the format moved. A bad CRC truncates the tail. | I have not measured a binary frame against this one. |
| Drain, per service, versioned | A template is new only when that service first emits it. Nothing is learned from lines that have not arrived. Reconstruction stays exact. | A service that always writes one-off lines looks novel. That is the Sock Shop failure. Lists of different lengths stay different templates. At the 5,000-cluster cap, matching slows down and new lines are stored verbatim. |
| Parquet + DuckDB in-process | The demo and the eval need no other server. | One process, one lock. A long query delays the next flush. |
| Minute rollups next to raw segments | The watch path and the ranker want counts. | I did not break rollup bytes out from the rest of the store. The whole store is below. |
| Exactly-once only inside 10 minutes, and only with a batch id | The id index is rebuilt from the WAL, so it survives a crash. Past the horizon I reject the retry rather than guess. | A stock Collector sends no batch id. For that sender the claim is at-least-once. |

## Evaluation

### Tests I ran here

On 12 Nov 2026, Linux, Node 24.22.3, Python 3.12.3:

- `pnpm test` (vitest, [`engine/vitest.config.ts`](engine/vitest.config.ts)): 36 passed, 5 files.
- `uv run --project evals pytest evals/tests -q`: 11 passed.
- `uv run --project evals ruff check evals`: clean.
- `pnpm --filter sift-engine typecheck`: clean.
- `make reproduce DRY_RUN=1`: prints the stages and does not download. It estimates ~1.0 GB for Dev and ~3.4 GB for all three systems. I did not run `make reproduce`.

| File | What it checks |
|---|---|
| [`engine/test/wal.test.ts`](engine/test/wal.test.ts) | Ack order, torn tail, batch-id dedup across restart, `SIFT-E105`, backpressure `SIFT-E103`. |
| [`engine/test/store.test.ts`](engine/test/store.test.ts) | Empty-store queries, lossless reconstruct, restart, crash leftovers deleted, compaction vs rollups. |
| [`engine/test/drain.test.ts`](engine/test/drain.test.ts) | Byte-for-byte reconstruct, versions, per-service online mining, identifier mask, verbatim past the cap. |
| [`engine/test/server.test.ts`](engine/test/server.test.ts) | Protobuf, JSON, gzip, bad bodies as RFC 9457, dedup, reconstructed query rows. |
| [`engine/test/watch.test.ts`](engine/test/watch.test.ts) | Schema check, quoted log text, flood, silence, steady traffic, cutoff, determinism. |
| [`evals/tests/test_scoring.py`](evals/tests/test_scoring.py) | Hit@k, tied tail, failure as a miss, bootstrap seed, disjoint splits, anonymised paths. |
| [`evals/tests/test_q2.py`](evals/tests/test_q2.py) | Loghub grouping accuracy: perfect, merged, split. |

Sift never sees the case directory name. Those names contain the answer. [`evals/src/sift_evals/run_sift.py`](evals/src/sift_evals/run_sift.py) copies the logs to a blind path. `test_sift_never_sees_the_case_name_or_answer` checks the command line. [`evals/src/sift_evals/guard.py`](evals/src/sift_evals/guard.py) refuses a test split until `PREREGISTRATION.md` is committed and clean (`SIFT-E301`, `SIFT-E302`). Test B also needs the tag `q3-frozen` (`SIFT-E303`).

Scoring is [`evals/src/sift_evals/scoring.py`](evals/src/sift_evals/scoring.py). The candidate set is RCAEval's own rule, shared by every method. Unranked candidates tie at the bottom and score as the expected rank under a random tie-break. I re-ran the Sock Shop baselines after fixing a bug that had scored an empty ranking as 0 instead of chance. That changed the traces-only row, not Sift's numbers. The front-end diagnosis is post-hoc. On Test B the baselines ran twice: the first run shared a cache directory with a stale process and wrote a corrupt file, so I discarded it before scoring. The agent run was restarted once after a machine reboot, before it had written output.

### Predictions

| Prediction (committed before the test set was read) | Outcome | Evidence |
|---|---|---|
| Logs-only multi-source BARO stays near chance (chance inside its 95% CI) | **failed** | Avg@5 0.555 [0.44, 0.67], chance 0.273 |
| Sift beats logs-only multi-source BARO (paired 95% CI above zero) | **failed** | difference -0.112 [-0.18, -0.04] |
| Sift stays below metric-based BARO on Avg@5 | held | 0.443 vs 0.768 |
| Sift's AC@1 is at least metric-based BARO's | **failed** | 0.075 vs 0.100 |
| Sift is stronger on code-level and LOSS than on CPU, MEM, DISK | held | 0.647 vs 0.324 (mean Avg@5) |
| Most of Sift's correct top-1 picks rest on restart or redeploy evidence | **failed** | 0 of 9 |
| Sift's test Avg@5 is below its Dev Avg@5 | held | 0.443 vs 0.533 |

3 of 7 predictions held.

| Prediction (addendum, committed and tagged before Test B was read) | Outcome | Evidence |
|---|---|---|
| Sift v2 beats Sift v1 on Avg@5 (paired 95% CI above zero) | held | 0.403 vs 0.348, difference +0.055 [+0.003, +0.105] |
| Sift v2 ranks no single service first in more than half of the cases | held | `ts-order-other-service` first in 14% |
| Sift v2 stays below metric-based BARO on Avg@5 | held | 0.403 vs 0.853 |
| Sift v2 beats logs-only multi-source BARO (paired 95% CI above zero) | held | difference +0.060 [+0.013, +0.115] |
| The gate cuts false issues per hour at least five-fold and loses at most 0.05 of any-service recall | **failed** | 108.81 to 43.55 per hour (2.5-fold); recall 0.692 to 0.792 |
| The model rung's right-service recall is within 0.05 of the gate's | held | 0.117 vs 0.117 (+0.000) |
| The model answers "open" to at least 90% of the gate-passed signals it sees | held | 99.3% of 922 calls |

6 of 7 predictions held.

### Design set (Online Boutique, 120 cases)

This is where I tuned, so it is optimistic. v1 Avg@5 0.533 against logs-only BARO 0.252. Test A v1 was 0.443.

| Method | Signal | AC@1 | AC@3 | Avg@5 | 95% CI | Lift over chance | Failed |
|---|---|---:|---:|---:|---:|---:|---:|
| **Sift v1 (logs)** | logs | 0.375 | 0.542 | 0.533 | [0.41, 0.66] | +0.283 | 0 |
| Sift v2 (logs) | logs | 0.392 | 0.567 | 0.558 | [0.43, 0.68] | +0.308 | 0 |
| Error-surge control (logs) | logs | 0.074 | 0.418 | 0.373 | [0.29, 0.46] | +0.123 | 0 |
| Multi-source BARO, logs only | logs | 0.150 | 0.250 | 0.252 | [0.15, 0.37] | +0.002 | 0 |
| Multi-source BARO, traces only | traces | 0.167 | 0.400 | 0.445 | [0.34, 0.56] | +0.195 | 0 |
| Multi-source BARO, metrics only | metrics | 0.117 | 0.892 | 0.745 | [0.68, 0.80] | +0.495 | 0 |
| Multi-source BARO, all signals | all | 0.117 | 0.892 | 0.738 | [0.67, 0.80] | +0.488 | 0 |
| BARO (metrics) | metrics | 0.100 | 0.900 | 0.742 | [0.68, 0.80] | +0.491 | 0 |

| Evidence behind a correct top-1 pick | Cases |
|---|---:|
| restart or redeploy | 30 |
| weak (no single item above threshold) | 8 |
| error lines | 4 |
| volume shift | 3 |

`productcatalogservice` writes any log line in 3/18 of its Dev root-cause cases ([`results/audit/audit.json`](results/audit/audit.json)). A logs-only method can only find it from other services' symptoms.

### Watch, without being told the alarm time

Dev, 120 cases, 300 s detection window, config not tuned (`DEFAULT_WATCH_CONFIG` in `watch.ts`):

| Rung | Detected, any service | Detected, right service | Median delay | False issues per hour | Issues per case |
|---|---:|---:|---:|---:|---:|
| Raw sensors | 0.483 [0.36, 0.61] | 0.068 [0.02, 0.13] | 36 s | 52.54 | 8.25 |
| + deterministic gate | 0.475 [0.35, 0.60] | 0.110 [0.05, 0.18] | 93 s | 4.0 | 2.27 |
| + local model | 0.475 [0.35, 0.60] | 0.127 [0.06, 0.20] | 93 s | 4.0 | 2.27 |

The gate takes false issues from 52.54 to 4.0 per hour (about 13-fold). mlx-community/Qwen2.5-3B-Instruct-4bit answered "open" to 99.4% of the gate-passed signals it saw, and named a different service in 3.9% of answers. Usable answers: 311 of 312. Median 3.5 s, 298 tokens in, 59 out. Right-service detection moved from 0.110 (gate) to 0.127 (model).

Test B, same config:

| Rung | Detected, any service | Detected, right service | Median delay | False issues per hour | Issues per case |
|---|---:|---:|---:|---:|---:|
| Raw sensors | 0.692 [0.59, 0.79] | 0.117 [0.03, 0.23] | 59 s | 108.81 | 18.48 |
| + deterministic gate | 0.792 [0.71, 0.87] | 0.117 [0.03, 0.23] | 84 s | 43.55 | 10.54 |
| + local model | 0.792 [0.71, 0.87] | 0.117 [0.03, 0.23] | 84 s | 43.42 | 10.54 |

On Train Ticket the gate took false issues from 108.81 to 43.55 per monitored hour, while detection of any service went from 0.692 to 0.792. Right-service detection was 0.117 with the gate and 0.117 with the model, which answered "open" to 99.3% of the 922 gate-passed signals it saw.

A false issue opened before the fault hides a later real one, because repeats for the same service and sensor count once. The gate removes some of those early issues, so its recall can exceed the raw sensors. Train Ticket is noisier (108.81 false issues per hour raw). The five-fold prediction is the failed row in the Test B prediction table.

### Crash, collector, throughput

These are the committed harness outputs. I did not rerun the 100-kill harness, the collector, or the throughput benchmark on this machine.

| Check | Result | File |
|---|---|---|
| SIGKILL under load, restart, resend unknown batches | 100 runs, 20,493,200 acked records, 0 lost, 0 duplicated | [`results/infra/crash.json`](results/infra/crash.json) |
| Of which random / named steps | 50 random; `wal.beforeFsync` (10), `wal.afterFsync` (10), `store.afterSegment` (10), `store.afterManifest` (10), `store.midCompaction` (10) | same |
| Same harness with recovery deliberately broken | 390,200 of 826,800 records lost across 6 runs | [`results/infra/crash_sensitivity.json`](results/infra/crash_sensitivity.json) |
| Temporal worker killed mid-investigation | killed at `llmVerdict`: 7 of 7 workflows completed, 5 issues for 5 opened names, 0 duplicated; killed at `openIssue`: 7 of 7 workflows completed, 5 issues for 5 opened names, 0 duplicated | [`results/infra/durable.json`](results/infra/durable.json) |
| Stock Collector, default exporter | otel/opentelemetry-collector-contrib:0.165.0: 32,531 of 32,531 lines, 0 missing, 0 duplicated. 702 lines arrive right-trimmed because `filelog` trims trailing whitespace | [`results/infra/collector.json`](results/infra/collector.json) |

Durability claim: no acknowledged record lost or duplicated on process crash, for a sender that retries with a batch id inside 10 minutes. Acks follow `fsync`. I do not claim power-loss durability. `wal.ts` notes that macOS would also need `F_FULLFSYNC`.

| Throughput, Apple M2, 8 GB RAM, Node 24.19.0, 685,716 real lines, one run | |
|---|---|
| Direct append (WAL fsync + mining) | 533,785 records/s |
| OTLP/HTTP protobuf, 8 senders | 315,648 records/s |
| Ack latency, 1,000-record batches | p50 19.8 ms, p99 253.6 ms |
| Ack to queryable | p99 157 ms |

Source: [`results/infra/throughput.json`](results/infra/throughput.json). Not extrapolated.

### What the store costs (Loghub-2.0)

Loghub-2.0 (Jiang et al., ISSTA 2024; Zenodo 8275861, CC-BY-4.0). 13 systems, 33,814,878 lines, 4.17 GB raw, with ground-truth templates. Each raw file goes through the store and through gzip, zstd, and ClickHouse. Every stored line is rebuilt and the SHA-256 of that stream is compared with the input. Sizes are MB. Machine recorded in [`results/q2/environment.json`](results/q2/environment.json): arm64 macOS. I did not rerun this ingest here.

| System | Lines | Raw MB | gzip -6 | zstd -19 | ClickHouse ZSTD(3) | Sift store | Sift WAL (not trimmed) | Lossless | Grouping accuracy, message | Grouping accuracy, full line |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| Apache | 51,978 | 5.0 | 0.3 | 0.2 | 0.3 | 0.6 | 8.0 | yes | 1.000 | 0.003 |
| BGL | 4,631,261 | 719.4 | 61.3 | 33.3 | 66.5 | 82.0 | 978.8 | yes | 0.555 | 0.887 |
| HDFS | 11,167,740 | 1,565.7 | 155.4 | 98.2 | 161.5 | 194.0 | 2,202.3 | yes | 0.999 | 0.999 |
| HPC | 429,988 | 32.6 | 3.2 | 2.0 | 3.3 | 5.6 | 56.7 | yes | 0.857 | 0.246 |
| Hadoop | 179,993 | 31.9 | 2.3 | 1.1 | 2.2 | 2.6 | 42.5 | yes | 0.933 | 0.728 |
| HealthApp | 212,394 | 20.5 | 2.0 | 1.3 | 2.1 | 4.1 | 33.7 | yes | 0.444 | 0.013 |
| Linux | 23,921 | 2.1 | 0.2 | 0.1 | 0.2 | 0.5 | 3.5 | yes | 0.807 | 0.005 |
| Mac | 100,314 | 15.4 | 1.3 | 0.6 | 1.1 | 1.7 | 21.1 | yes | 0.789 | 0.744 |
| OpenSSH | 638,947 | 70.5 | 4.5 | 2.9 | 5.0 | 7.2 | 108.9 | yes | 0.780 | 0.000 |
| OpenStack | 207,632 | 61.4 | 5.3 | 3.8 | 5.2 | 5.8 | 74.5 | yes | 0.891 | 0.318 |
| Proxifier | 21,320 | 2.5 | 0.2 | 0.1 | 0.2 | 0.3 | 3.8 | yes | 0.015 | 0.001 |
| Spark | 16,075,117 | 1,629.4 | 94.3 | 58.9 | 105.3 | 154.8 | 2,561.8 | yes | 0.889 | 0.888 |
| Zookeeper | 74,273 | 10.3 | 0.5 | 0.3 | 0.5 | 0.7 | 14.9 | yes | 1.000 | 0.956 |
| **All 13** | 33,814,878 | 4,166.8 | 330.7 | 202.7 | 353.5 | 459.9 | 6,110.5 | | | |

Lossless on 13 of 13 systems. The store is 9.1× smaller than raw, against 20.6× for zstd -19. gzip -6 is 12.6× smaller than raw. ClickHouse ZSTD(3) is 11.8×. Grouping accuracy, Loghub's definition, averages 0.766 on the benchmark's message text and 0.445 on the full line the store keeps. The miner was written for OTLP bodies, where time and severity are separate fields. The WAL column is a second copy: it is not deleted after commit. Thunderbird was not run in full: on its first 200,000 lines Sift ingested 1,695 lines/s with 4,698 templates, against a median of 34,652 lines/s over the systems run in full (slowest: HealthApp, 595 lines/s), so the full file would take hours. Both slow systems approach the miner's cap of 5,000 templates per service, where matching a line scans many clusters.

## Limitations

- One process. The crash numbers are `SIGKILL` of that process, not a disk losing power.
- No authentication. It binds `127.0.0.1` and must not face a network.
- Three RCAEval systems, injected faults, each test set opened once. Some root-cause services barely log (`productcatalogservice`, 3/18 on Dev).
- Throughput is one laptop run. I have not profiled the p99.
- The store is lossless and still larger than gzip on these files. The untrimmed WAL is larger than the raw log.
- mlx-community/Qwen2.5-3B-Instruct-4bit does not improve on the gate. On Train Ticket, right-service recall stays at 0.117.

## What I'd do next

1. Trim the WAL after a commit and rerun the Loghub table. [`engine/bench/storage.ts`](engine/bench/storage.ts) already reports it separately because it is not trimmed.
2. Parse the header into columns before mining, and store parameters as typed columns instead of JSON text. That is the gap between grouping accuracy 0.766 on the message and 0.445 on the full line.
3. Index Drain's clusters. Near the 5,000-template cap, matching scans many clusters. That is why Thunderbird was probed on 200,000 lines instead of run in full.
4. Point the model at the callers' error lines and score whether it names the upstream service. The gate already does the filtering.

## Run it

Node >= 24, pnpm 10.17.1 (see [`package.json`](package.json)). Python 3.12 and [uv](https://docs.astral.sh/uv/) for the evals.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm --filter sift-engine typecheck
pnpm build
pnpm demo

node engine/dist/surfaces/cli.js rca \
  --logs fixtures/demo/logs.parquet \
  --at 1731905504 \
  --config configs/rank.json

node engine/dist/surfaces/cli.js doctor --json
```

I ran those on this checkout. `doctor` reported Node 24.22.3 ok and `SIFT_LLM_BASE_URL` unset, so the model rung is skipped. I did not start Docker.

```bash
uv sync --project evals --frozen
uv run --project evals pytest evals/tests -q
uv run --project evals ruff check evals
uv run --project evals python -m sift_evals.report   # rewrites README.md from results/

make reproduce DRY_RUN=1
make reproduce    # downloads RCAEval; I did not run this here
```

Durable investigations need Temporal and Postgres:

```bash
docker compose -f deploy/docker-compose.yml up -d
```

Images in that file: `postgres:16.4` and `temporalio/temporal:1.10.0`, bound to `127.0.0.1`. I did not run compose here.

Error codes, each with the failing value and a `fix:` line: [`docs/errors.md`](docs/errors.md).

## Repo map

| Path | What it is |
|---|---|
| [`engine/src/logstore/wal.ts`](engine/src/logstore/wal.ts) | Group-commit WAL, CRC, dedup horizon. |
| [`engine/src/logstore/store.ts`](engine/src/logstore/store.ts) | Manifest, Parquet, rollups, DuckDB, compaction. |
| [`engine/src/templates/drain.ts`](engine/src/templates/drain.ts) | Online miner, versioned, lossless. |
| [`engine/src/detect/rank.ts`](engine/src/detect/rank.ts) | v1 and v2 ranker. |
| [`engine/src/detect/watch.ts`](engine/src/detect/watch.ts) | Forward-only sensors. |
| [`engine/src/detect/investigate.ts`](engine/src/detect/investigate.ts) | Gate, evidence, model schema. |
| [`engine/src/durable/workflows.ts`](engine/src/durable/workflows.ts) | Temporal workflow per investigation. |
| [`engine/src/surfaces/server.ts`](engine/src/surfaces/server.ts) | OTLP and query HTTP. |
| [`engine/src/surfaces/cli.ts`](engine/src/surfaces/cli.ts) | CLI. |
| [`engine/src/surfaces/demo.ts`](engine/src/surfaces/demo.ts) | `pnpm demo`. |
| [`engine/src/errors.ts`](engine/src/errors.ts) | Stable error codes. |
| [`engine/bench/crash.ts`](engine/bench/crash.ts) | SIGKILL harness. |
| [`engine/bench/throughput.ts`](engine/bench/throughput.ts) | Ack rate and latency. |
| [`engine/bench/storage.ts`](engine/bench/storage.ts) | Loghub byte measurement. |
| [`configs/rank.json`](configs/rank.json) | Frozen v1 weights. |
| [`configs/rank_v2.json`](configs/rank_v2.json) | v2, `noveltyBaseline: true`. |
| [`PREREGISTRATION.md`](PREREGISTRATION.md) | Predictions, written before each test set. |
| [`evals/src/sift_evals/report.py`](evals/src/sift_evals/report.py) | Regenerates this README. |
| [`evals/src/sift_evals/scoring.py`](evals/src/sift_evals/scoring.py) | AC@k, Avg@5, bootstrap. |
| [`evals/src/sift_evals/baselines.py`](evals/src/sift_evals/baselines.py) | RCAEval BARO, per signal. |
| [`evals/src/sift_evals/guard.py`](evals/src/sift_evals/guard.py) | Refuses an early look at a test set. |
| [`manifests/`](manifests) | SHA-256 pins for RCAEval files. |
| [`results/`](results) | Per-case outputs the numbers come from. |
| [`fixtures/demo/`](fixtures/demo) | The bundled incident. |
| [`deploy/docker-compose.yml`](deploy/docker-compose.yml) | Local Temporal and Postgres. |
| [`docs/errors.md`](docs/errors.md) | Error catalogue. |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Typecheck, vitest, a 10-run crash smoke, the demo, pytest, ruff, README drift. |

The same tables are rendered to [`site/index.html`](site/index.html) (GitHub Pages: <https://vijaychamakuri.github.io/sift/>).

## Licence

MIT, [LICENSE](LICENSE). RCAEval code and data: MIT (Luan Pham). OpenTelemetry protos under [`engine/proto/`](engine/proto): Apache-2.0. Loghub-2.0: CC-BY-4.0.
