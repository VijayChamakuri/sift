# Changelog

## 0.1.0 (2026-11-11)

- Engine: OTLP/HTTP intake (protobuf and JSON), group-commit write-ahead log with batch-id deduplication and backpressure, online versioned template mining with byte-for-byte reconstruction, Parquet segments and rollups committed by one atomic manifest, compaction, DuckDB queries, logs-only root-cause ranker, CLI and demo.
- Crash harness: 100 SIGKILL runs (random and at each commit step) with a sensitivity check against a deliberately broken recovery; throughput and ack-latency benchmark.
- Evaluation on RCAEval: data audit, RCAEval BARO and multi-source BARO re-run per signal, error-surge control, scoring with a shared candidate set, failures counted as misses, cluster bootstrap, default-pick and evidence diagnostics.
- Dev design and tuning (two logged rounds), then `PREREGISTRATION.md` committed before Test A.
