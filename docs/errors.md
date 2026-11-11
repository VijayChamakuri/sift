# Error codes

Every Sift error has a stable code. The first line says what failed, with the actual value; the
last line (`fix:`) is the next step. The CLI exits non-zero and writes to stderr (`--json` gives
the same fields as JSON). HTTP errors return an RFC 9457 problem body
(`application/problem+json`) with `title` = the code and a `fix` field.

| Code | Where | Meaning | Retry? |
|---|---|---|---|
| <a id="sift-e101"></a>SIFT-E101 | intake | Body is not a valid OTLP `ExportLogsServiceRequest`, or the content type is unsupported. HTTP 400/415. | No: fix the request. |
| <a id="sift-e102"></a>SIFT-E102 | intake | Body larger than the server's limit (16 MiB). HTTP 413. | No: send smaller batches. |
| <a id="sift-e103"></a>SIFT-E103 | intake | Write-ahead log is behind (backpressure), or a sender gave up after its retry limit. HTTP 429 with `Retry-After`. | Yes, with the same batch id. |
| <a id="sift-e104"></a>SIFT-E104 | CLI, evals | An input file, dataset or config is missing or unreadable, or a run has no outcome for some case. | After fixing the input. |
| <a id="sift-e105"></a>SIFT-E105 | intake | A retry whose first attempt is older than the dedup horizon (10 min). HTTP 409. Rejected because it cannot be told apart from a new batch. | No: resend as a new batch. |
| <a id="sift-e201"></a>SIFT-E201 | storage | A WAL frame failed its checksum before the tail. | No: restore from backup. |
| <a id="sift-e202"></a>SIFT-E202 | storage | The data directory or manifest is unusable (permissions, disk full, corrupt manifest). HTTP 503 from intake. | After fixing the directory. |
| <a id="sift-e203"></a>SIFT-E203 | query | A query failed; the message names the views and their columns. | After fixing the SQL. |
| <a id="sift-e301"></a>SIFT-E301 | evals | A test set was requested before `PREREGISTRATION.md` was committed. | After committing it. |
| <a id="sift-e302"></a>SIFT-E302 | evals | `PREREGISTRATION.md` has uncommitted changes. | After commit or revert. |
| <a id="sift-e303"></a>SIFT-E303 | evals | Test B was requested before the `q3-frozen` tag exists. | After freezing Q3. |
| <a id="sift-e401"></a>SIFT-E401 | CLI, API | Usage error: a missing or invalid argument. Exit code 2. | After fixing the arguments. |
| <a id="sift-e500"></a>SIFT-E500 | CLI | Unexpected failure. The message names a file holding the full trace. | Rerun; report with the trace file if it repeats. |

CLI exit codes: `0` ok, `1` unexpected or retryable, `2` usage, `3` input or environment.
