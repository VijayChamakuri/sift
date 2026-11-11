# Sift

**Can an agent find the broken service from logs alone?** Sift is a logs-only observability
engine (OTLP intake, write-ahead log, online template mining, Parquet storage, root-cause
ranking) and a pre-registered measurement of that question on injected faults in real
microservice systems.

**The first test says: not yet, and it says why.** Sift was designed and tuned on Online
Boutique, where it reached Avg@5 {{dev_sift_avg5}} from logs alone, against {{dev_logs_avg5}} for
the published multi-source method given the same logs. Its configuration and seven predictions
were then committed, and a second system, Sock Shop, was opened once. There, the frozen Sift
reached Avg@5 **{{sift_avg5}}** (AC@1 {{sift_ac1}}) and ranked `{{sift_top1_service}}` first in
{{sift_top1_share}} of cases. The published method on the same logs reached {{logs_baro_avg5}};
given metrics, {{metrics_baro_avg5}}. Paired difference, Sift minus that method on logs:
{{paired_diff}} (95% CI {{paired_ci}}). {{predictions_held}} of the seven predictions held.

The reason is specific and fixable, and the fix will be pre-registered before the next system is opened (below): Sift
counts every template it has never seen as evidence, and Sock Shop's front-end writes new,
one-off lines all the time, faults or not. Online Boutique's services rarely do.

### At a glance

| | |
|---|---|
| **Engine** | OTLP/HTTP intake → write-ahead log (ack after fsync) → online template mining → Parquet + rollups under one atomic manifest → DuckDB. TypeScript, one process, no services needed. |
| **Durability** | {{crash_runs}} SIGKILL crash runs, {{crash_records}} acknowledged records: **{{crash_lost}} lost, {{crash_dup}} duplicated**. The same harness catches a deliberately broken recovery. |
| **Throughput** | {{tp_http}} records/s over OTLP/HTTP, ack p50 {{tp_p50}} ms / p99 {{tp_p99}} ms, on a laptop ({{machine}}). |
| **Question** | Can logs alone rank the root-cause service? Pre-registered, three-system design, test sets opened once. |
| **Answer so far** | Not reliably: the Dev design did not transfer to the first test system ({{predictions_held}} of 7 predictions held). Cause diagnosed; the fix will be pre-registered before the next system is opened. |
| **Try it** | `pnpm install && pnpm demo`: a real incident, end to end, in about ten seconds. |

![Avg@5 by fault type](docs/figures/by_fault.png)

> Every number on this page is generated from committed per-case outputs by
> `evals/src/sift_evals/report.py`; CI regenerates the page and fails if anything differs.

## Results

### {{head_label}}

{{head_table}}

Avg@5 is the mean of AC@1..AC@5 (RCAEval's definitions), at service level. A random ranking over
the same candidates scores {{chance_avg5}}. Intervals are 95% paired cluster bootstraps over
(service, fault) scenarios. Every case counts: a failed run scores as a miss.

### Pre-registered predictions

{{predictions_table}}

### Correct top-1 picks by evidence

{{evidence_table}}

On Dev, most correct picks came from restart or redeploy lines (start-up banners after the fault
injection restarted a container). In Sock Shop, none did.

### Where logs work and where they do not

{{fault_table}}

### What the logs carry: same method, different signals

![Signal ablation](docs/figures/ablation.png)

Multi-source BARO is run with RCAEval's own code; only its input changes. This isolates what
each signal carries for that method. What logs carry depends on the system: on Online Boutique
(Dev) the logs-only variant is at chance ({{dev_logs_lift}} lift), on Sock Shop it is well above
it ({{logs_baro_lift}}). Sock Shop has no traces, so its traces-only row ranks nothing and scores
as a random ranking.

### Default-pick check

A method that ranks the same service first in most cases looks accurate whenever that service is
the answer. For every method, the service it ranks first most often, against how often that
service is the answer:

{{concentration_table}}

## Try it

```bash
pnpm install && pnpm demo
```

Replays one real incident (a bundled RCAEval Dev case) through the full path: OTLP/HTTP intake,
write-ahead log, template mining, Parquet, ranking. It prints the ranked services, the log lines
that decided it, and the ground truth. Node 24 and pnpm only: no Docker, no download, no model.

## How it works

```
 OTel SDK / Collector / replay ──OTLP/HTTP──▶ intake ──▶ write-ahead log (fsync, then ack)
                                                              │ in WAL order
                                                              ▼
                                  template miner (online Drain, per service, versioned, lossless)
                                                              ▼
                     Parquet segments + minute rollups, committed by one atomic manifest
                                                              ▼
                     DuckDB queries ──▶ ranker: novelty, error surge, volume shift ──▶ CLI / API
```

| Module | Owns |
|---|---|
| `engine/src/logstore` | WAL, manifest, Parquet segments, compaction, rollups, the DuckDB instance |
| `engine/src/templates` | Online template mining with versioned, byte-for-byte reconstruction |
| `engine/src/detect` | Root-cause ranking |
| `engine/src/surfaces` | OTLP/HTTP intake, query API, CLI, demo |
| `evals/` | Data audit, baselines, scoring, this page |

The ranker scores each service from template counts in the 300 s before and after the alarm:
templates seen for the first time after it (mined online, so nothing is learned from the
future), error templates that grow, and log volume that departs from the system-wide trend
(a Poisson z-score, so a traffic drop everywhere is not evidence). Weights were chosen on Dev from
a logged grid of {{tuning_trials}} settings (Dev Avg@5 from {{tuning_min}} to {{tuning_max}}; chosen
`{{tuning_chosen}}`) and frozen before any test case was read.

## Design decisions and trade-offs

| Decision | Why | What it costs | What would change at scale |
|---|---|---|---|
| **Ack only after `fsync`, with group commit** | An acknowledged record survives a crash. Appends that arrive during one fsync share the next one, so throughput comes from batching, not from skipping the fsync. | Every ack waits for at least one fsync. | Replicate the log (quorum acks) instead of relying on one disk. |
| **The WAL is the only source of truth** | Templates, segments and rollups are all derived, so recovery is "load the last manifest, replay the log after it". One commit boundary, testable at every step. | Replay time grows with the unflushed tail (bounded by the 1 s flush). | Checkpoint per partition; truncate the log behind the manifest. |
| **JSON frames in the WAL** | Readable with standard tools while the format settles; CRC32 per frame finds torn tails. | Larger and slower to encode than a binary format (not yet measured). | Binary encoding (protobuf as received, or a columnar batch). |
| **Online, per-service template mining (Drain)** | No future data leaks into the past: a template is new only when it first arrives. Per-service trees keep one service's patterns from absorbing another's. Lossless: every line rebuilds byte for byte. | A service that always writes one-off lines looks permanently novel; this is exactly the Test A failure. Lists of different lengths become separate templates. | Score novelty against each service's own rate (Sift v2); mask variable-length lists. |
| **Parquet + DuckDB, embedded** | No servers to run, so the demo and the evaluation run anywhere; columnar storage with zstd suits template ids and parameters. | One process. Queries and flushes take one lock, so a long query delays the next flush. | Object storage for segments, a transactional catalog for the manifest, stateless query workers. |
| **Minute rollups beside raw segments** | Most questions an agent asks ("which service's errors grew?") are counts; rollups answer them without scanning raw rows. | Extra bytes per flush (to be measured with the cost work). | Pre-aggregates per tenant and service, kept longer than raw data. |
| **Exactly-once only within a stated window** | Batch ids are remembered for 10 minutes and rebuilt from the log after a crash; an older retry is rejected rather than risk a duplicate. | A sender without ids (a stock Collector) gets at-least-once. | Ids in a replicated index with a longer, configurable window. |

## Interfaces

| Surface | What it does |
|---|---|
| `POST /v1/logs` | OTLP/HTTP logs, protobuf or JSON. Optional headers `x-sift-batch-id` and `x-sift-batch-created` make retries exactly-once within the window. Errors are RFC 9457 problem bodies with a stable code; overload is `429` with `Retry-After`. |
| `POST /query` | SQL over the views `logs`, `rollups` and `templates`; `"reconstruct": true` adds each row's original line. |
| `GET /rank?at=<unix s>` | Ranked root-cause candidates with the evidence lines behind each. |
| `sift serve \| replay \| rank \| rca \| doctor` | CLI; every command takes `--json` and runs without prompts. |

Binds `127.0.0.1` by default: there is no authentication yet, so it must not face a network.

## Scaling beyond one node (design, not built)

Sift is one process by design: the question was whether the data answers it, not how many
machines it takes. The shape it would grow into:

- **Partition** by (tenant, service). Each partition has its own log, miner state and manifest,
  so services never contend and a hot tenant can be moved alone.
- **Replicate the log** with quorum acks, keeping today's contract: an ack still means the
  record survives the loss of a machine, not just a process.
- **Segments to object storage**, the manifest in a transactional catalog (Postgres), so a
  commit stays one atomic pointer swap and old manifests stay readable.
- **Stateless query workers** read Parquet and rollups from object storage; the agent's count
  questions hit rollups first.
- **Regions as cells:** data is ingested, stored and queried in its own region; only metadata
  crosses regions.
- **Deploys and rollback:** because manifests are immutable versions, rolling back a bad
  compaction or format change is pointing back to the previous manifest; ingest nodes drain
  by flushing and handing the log tail to the next process.

## Limitations

- One node; the durability claim is process crash, not machine or power loss.
- No authentication; local use only.
- The ranker is deterministic and uses no language model yet; an LLM investigator is the next
  phase.
- Results cover three RCAEval systems with injected faults; Test B is still sealed.
- Throughput is one run on one laptop; the p99 ack latency has not been profiled yet.

## Durability

| Check | Result |
|---|---|
| Crash runs (SIGKILL under load, restart, resend unknown batches) | {{crash_runs}} |
| Random kills | {{crash_random}} |
| Kills at named commit steps | {{crash_points}} |
| Acknowledged records | {{crash_records}} |
| Lost | **{{crash_lost}}** |
| Duplicated | **{{crash_dup}}** |
| Harness sensitivity: same runs with recovery deliberately broken | {{sens_lost}} of {{sens_acked}} records lost across {{sens_runs}} runs (detected) |

The claim is "no acknowledged record lost or duplicated on process crash, for a sender that uses
batch ids within the 10-minute retry window". Acks follow `fsync`; power-loss durability on
macOS would also need `F_FULLFSYNC` and is not claimed. A stock OpenTelemetry Collector sends no
batch id, so for it the claim is at-least-once.

| Throughput ({{machine}}) | |
|---|---|
| Direct append (WAL fsync + template mining) | {{tp_direct}} records/s |
| OTLP/HTTP protobuf, 8 senders | {{tp_http}} records/s |
| Ack latency per 1,000-record batch | p50 {{tp_p50}} ms, p99 {{tp_p99}} ms |
| Ack to queryable | p99 {{tp_fresh_p99}} ms |

Measured with {{tp_records}} real log lines on one laptop; not extrapolated.

## Method

- **Data:** RCAEval (Pham et al., WWW 2025), pinned at commit `90b63a4`. Dev: Online Boutique
  (RE2-OB, RE3-OB). Test A: Sock Shop (RE2-SS, RE3-SS), opened once. Test B: Train Ticket,
  sealed until the next phase. Sift reads each case through an anonymised path, because RCAEval
  directory names contain the answer; a test enforces it.
- **Pre-registration:** [PREREGISTRATION.md](PREREGISTRATION.md), committed before Test A was read.
- **Candidates:** RCAEval's own candidate rule, the same for every method.
- **Coverage limit:** some root-cause services barely log. In Dev, `productcatalogservice` writes
  any log line in only {{pc_coverage}} of its root-cause cases, so a logs-only method can only find
  it through the symptoms of others.

- **Corrections after the test was read** (none changes Sift's numbers): the baseline runner
  recorded an empty ranking as a failure, which scored Sock Shop's traces-only row as 0 instead of
  a random ranking; fixed and re-run. The diagnosis of Sift's `front-end` failure above is
  post-hoc analysis of Test A.

### Dev results (design set)

{{dev_table}}

{{dev_concentration_table}}

{{dev_evidence_table}}

## What's next

- **Sift v2, to be pre-registered before Test B is opened:** score new templates against the service's
  own rate of new templates before the alarm, as the error-surge score already does, so a chatty
  service is not evidence by default. Designed on Dev; v1 and v2 are both scored on Test B
  (Train Ticket), which no design has seen.
- **Q3, investigate before alert:** sensors fire, a deterministic gate re-measures, a local model
  decides whether to open an issue, on forward-only replay with no access to the injection time.
- **Cost:** lossless compression and query cost on Loghub-2.0 against gzip, zstd, ClickHouse and CLP.

## Reproduce

```bash
make reproduce DRY_RUN=1   # prints disk and time estimates, downloads nothing
make reproduce             # fetch, audit, baselines, Sift, scoring, this page
```

## Errors

Every error has a stable code, the failing value on its first line and the fix on its last:
[docs/errors.md](docs/errors.md).

## Licence

MIT. RCAEval data and code: MIT (Luan Pham). OpenTelemetry protos: Apache-2.0.
