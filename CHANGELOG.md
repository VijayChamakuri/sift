# Changelog

## 0.2.0 (2026-11-11)

- Agent: `sift watch` (forward-only sensors, deterministic gate, local model through the Vercel AI SDK) and `sift worker` (Temporal workflow per investigation, idempotent issues in Postgres), with a worker-kill test.
- Interop: a stock OpenTelemetry Collector delivers every line; gzip intake with an inflation limit; empty-store queries fixed.
- Sift v2 (novelty against the service's own pre-alarm rate) tuned on Dev; Test B addendum with seven predictions committed and tagged `q3-frozen`.
- Test B (Train Ticket) opened once: Sift v1, v2, baselines and the agent's three rungs, all scored; predictions checked by code. Cases without a log file score as misses.
- Storage cost on Loghub-2.0: Sift's store against gzip, zstd and ClickHouse, a byte-for-byte rebuild check on every system, and grouping accuracy.

## 0.1.0 (2026-11-11)

- Engine: OTLP/HTTP intake (protobuf and JSON), group-commit write-ahead log with batch-id deduplication and backpressure, online versioned template mining with byte-for-byte reconstruction, Parquet segments and rollups committed by one atomic manifest, compaction, DuckDB queries, logs-only root-cause ranker, CLI and demo.
- Crash harness: 100 SIGKILL runs (random and at each commit step) with a sensitivity check against a deliberately broken recovery; throughput and ack-latency benchmark.
- Evaluation on RCAEval: data audit, RCAEval BARO and multi-source BARO re-run per signal, error-surge control, scoring with a shared candidate set, failures counted as misses, cluster bootstrap, default-pick and evidence diagnostics.
- Dev design and tuning (two logged rounds), then `PREREGISTRATION.md` committed before Test A.
