/**
 * Replay a log file (Parquet with timestamp, container_name, message, e.g. RCAEval's logs.parquet)
 * into a store, either directly or through the OTLP/HTTP intake. Event time is preserved exactly;
 * replay speed only changes when batches are sent.
 */
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { DuckDBInstance } from "@duckdb/node-api";

import { SiftError } from "../errors.js";
import type { LogStore } from "../logstore/store.js";
import type { LogRecord } from "../types.js";
import { encodeRequest } from "./otlp.js";

/** Normalise a timestamp of unknown unit (s, ms, us or ns) to a nanosecond string. */
export function toNs(ts: bigint): string {
  const a = ts < 0n ? -ts : ts;
  if (a >= 100_000_000_000_000_000n) return ts.toString(); // ns
  if (a >= 100_000_000_000_000n) return (ts * 1_000n).toString(); // us
  if (a >= 100_000_000_000n) return (ts * 1_000_000n).toString(); // ms
  return (ts * 1_000_000_000n).toString(); // s
}

export async function readLogFile(path: string): Promise<LogRecord[]> {
  try {
    await access(path);
  } catch {
    throw new SiftError("SIFT-E104", `log file not found: ${path}`,
      "pass --logs <file.parquet> (columns: timestamp, container_name, message); for RCAEval run: make fetch");
  }
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    const reader = await conn.runAndReadAll(
      `select timestamp::bigint ts, container_name::varchar service, coalesce(message, '')::varchar body
       from (select *, row_number() over () rn from read_parquet('${path.replaceAll("'", "''")}'))
       order by ts, rn`,
    );
    return (reader.getRowObjectsJS() as { ts: bigint; service: string; body: string }[]).map((r) => ({
      tsNs: toNs(r.ts),
      service: r.service || "unknown_service",
      body: r.body,
    }));
  } finally {
    conn.closeSync();
    db.closeSync();
  }
}

function* batches(records: LogRecord[], size: number): Generator<LogRecord[]> {
  for (let i = 0; i < records.length; i += size) yield records.slice(i, i + size);
}

export async function replayDirect(store: LogStore, records: LogRecord[], batchSize = 2000, inflight = 8): Promise<void> {
  const pending = new Set<Promise<unknown>>();
  for (const b of batches(records, batchSize)) {
    const p = store.append({ batchId: randomUUID(), records: b });
    pending.add(p);
    p.finally(() => pending.delete(p)).catch(() => undefined);
    if (pending.size >= inflight) await Promise.race(pending);
  }
  await Promise.all(pending);
}

/** Send through OTLP/HTTP with Sift's sender contract: a batch id, its creation time, bounded retries. */
export async function replayHttp(url: string, records: LogRecord[], batchSize = 2000, maxAttempts = 8): Promise<{ batches: number; retries: number }> {
  let retries = 0;
  let n = 0;
  for (const b of batches(records, batchSize)) {
    const id = randomUUID();
    const created = Date.now();
    const body = Buffer.from(encodeRequest(b));
    for (let attempt = 1; ; attempt++) {
      let status = 0;
      let retryAfter = 0;
      try {
        const res = await fetch(`${url.replace(/\/$/, "")}/v1/logs`, {
          method: "POST",
          headers: { "content-type": "application/x-protobuf", "x-sift-batch-id": id, "x-sift-batch-created": String(created) },
          body,
        });
        status = res.status;
        retryAfter = Number(res.headers.get("retry-after") ?? 0);
        await res.arrayBuffer();
      } catch {
        status = 0; // network error: the outcome is unknown, so retry with the same id
      }
      if (status === 200) break;
      if (status !== 0 && status !== 429 && status < 500) {
        throw new SiftError("SIFT-E101", `intake rejected batch ${id} with HTTP ${status}`, "check the server log for the problem body; the batch was not stored");
      }
      if (attempt >= maxAttempts) {
        throw new SiftError("SIFT-E103", `batch ${id} not acknowledged after ${attempt} attempts (last status ${status || "network error"})`,
          `check the server at ${url}; resend the batch with the same id (${id}) within the dedup horizon`, { retryable: true });
      }
      retries += 1;
      await new Promise((r) => setTimeout(r, Math.max(retryAfter * 1000, 50 * 2 ** attempt)));
    }
    n += 1;
  }
  return { batches: n, retries };
}
