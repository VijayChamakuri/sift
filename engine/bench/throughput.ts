/**
 * Throughput and latency on this machine, with real log lines (an RCAEval Dev case, repeated).
 *
 *   direct  records/s through append → WAL fsync → template mining (no HTTP)
 *   http    records/s and per-batch ack latency through OTLP/HTTP protobuf, N concurrent senders
 *   fresh   ingest-to-queryable: time from ack to the record being visible to a query (flush every 1 s)
 *
 * Single laptop, single process; numbers are not extrapolated to a cluster.
 * Usage: tsx bench/throughput.ts --logs <logs.parquet> --out ../results/infra/throughput.json
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { LogStore } from "../src/logstore/store.js";
import { encodeRequest } from "../src/surfaces/otlp.js";
import { readLogFile } from "../src/surfaces/replay.js";
import type { LogRecord } from "../src/types.js";

const CLI = fileURLToPath(new URL("../dist/surfaces/cli.js", import.meta.url));
const { values } = parseArgs({
  options: {
    logs: { type: "string" },
    out: { type: "string", default: "../results/infra/throughput.json" },
    repeat: { type: "string", default: "4" },
    batch: { type: "string", default: "1000" },
    senders: { type: "string", default: "8" },
  },
});

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

const base = await readLogFile(values.logs!);
const records: LogRecord[] = [];
for (let k = 0; k < Number(values.repeat); k++) for (const r of base) records.push(r);
const size = Number(values.batch);
const batches: LogRecord[][] = [];
for (let i = 0; i < records.length; i += size) batches.push(records.slice(i, i + size));

// direct
const dirA = await mkdtemp(join(tmpdir(), "sift-tp-"));
const store = await LogStore.open(dirA);
let t0 = performance.now();
const inflight = new Set<Promise<unknown>>();
for (const b of batches) {
  const p = store.append({ batchId: randomUUID(), records: b });
  inflight.add(p);
  p.finally(() => inflight.delete(p)).catch(() => undefined);
  if (inflight.size >= 8) await Promise.race(inflight);
}
await Promise.all(inflight);
const directSec = (performance.now() - t0) / 1000;
await store.close();
await rm(dirA, { recursive: true, force: true });

// http
const dirB = await mkdtemp(join(tmpdir(), "sift-tp-"));
const proc = spawn(process.execPath, [CLI, "serve", "--data", dirB, "--port", "0", "--json"], { stdio: ["ignore", "pipe", "inherit"] });
const url = await new Promise<string>((resolve) => {
  let buf = "";
  proc.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    const line = buf.split("\n").find((l) => l.includes("listening"));
    if (line) resolve((JSON.parse(line) as { listening: string }).listening);
  });
});
const bodies = batches.map((b) => Buffer.from(encodeRequest(b)));
const latencies: number[] = [];
let next = 0;
let rejected = 0;
t0 = performance.now();
await Promise.all(Array.from({ length: Number(values.senders) }, async () => {
  while (next < bodies.length) {
    const i = next++;
    const id = randomUUID();
    for (;;) {
      const s = performance.now();
      const res = await fetch(`${url}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf", "x-sift-batch-id": id, "x-sift-batch-created": String(Date.now()) },
        body: bodies[i],
      });
      await res.arrayBuffer();
      if (res.status === 200) {
        latencies.push(performance.now() - s);
        break;
      }
      rejected += 1;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}));
const httpSec = (performance.now() - t0) / 1000;

// freshness: ack → visible to a query
const fresh: number[] = [];
for (let k = 0; k < 20; k++) {
  const marker = `freshness-probe-${k}-${randomUUID()}`;
  const ack = performance.now();
  const res = await fetch(`${url}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/x-protobuf" },
    body: Buffer.from(encodeRequest([{ tsNs: String(BigInt(Date.now()) * 1_000_000n), service: "probe", body: marker }])),
  });
  await res.arrayBuffer();
  for (;;) {
    const q = await fetch(`${url}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "select count(*)::integer n from logs where service = 'probe'" }),
    });
    const { rows } = (await q.json()) as { rows: { n: number }[] };
    if ((rows[0]?.n ?? 0) > k) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  fresh.push(performance.now() - ack);
}
proc.kill("SIGTERM");
await rm(dirB, { recursive: true, force: true });

const out = {
  input: { file: values.logs, uniqueLines: base.length, records: records.length, batchSize: size, senders: Number(values.senders) },
  direct: { seconds: +directSec.toFixed(2), recordsPerSec: Math.round(records.length / directSec) },
  http: {
    seconds: +httpSec.toFixed(2),
    recordsPerSec: Math.round(records.length / httpSec),
    ackLatencyMs: { p50: +pct(latencies, 50).toFixed(1), p99: +pct(latencies, 99).toFixed(1), max: +pct(latencies, 100).toFixed(1) },
    backpressureRetries: rejected,
  },
  ingestToQueryableMs: { p50: +pct(fresh, 50).toFixed(0), p99: +pct(fresh, 99).toFixed(0), note: "flush interval 1000 ms; query flushes on demand" },
  machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30), node: process.versions.node, platform: process.platform },
  measuredAt: new Date().toISOString(),
};
await mkdir(dirname(values.out!), { recursive: true });
await writeFile(values.out!, JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
