/**
 * Crash harness: kill the server under load, restart it, and check every acknowledged record.
 *
 * Each run:
 *   1. start `sift serve` on a fresh data directory (flush every 1 s, compaction every 10 flushes)
 *   2. send batches of uniquely numbered records with Sift's sender contract (batch id + creation time)
 *   3. kill the server with SIGKILL: at a random moment, or at a named commit step via SIFT_CRASH_AT
 *   4. restart it on the same directory; resend every batch whose outcome is unknown, same id
 *   5. query all stored lines and check: each acknowledged record exactly once, nothing unknown stored twice
 *
 * Usage: tsx bench/crash.ts --runs 100 --out ../results/infra/crash.json [--seed 7]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { encodeRequest } from "../src/surfaces/otlp.js";
import type { LogRecord } from "../src/types.js";

const CLI = fileURLToPath(new URL("../dist/surfaces/cli.js", import.meta.url));
const POINTS = ["wal.beforeFsync", "wal.afterFsync", "store.afterSegment", "store.afterManifest", "store.midCompaction"] as const;

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "100" },
    out: { type: "string", default: "../results/infra/crash.json" },
    seed: { type: "string", default: "7" },
    batch: { type: "string", default: "200" },
  },
});

let state = Number(values.seed);
const rand = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

interface Server { proc: ChildProcess; url: string; exited: Promise<number | null> }

async function startServer(dir: string, crashAt?: string): Promise<Server> {
  const proc = spawn(process.execPath, [CLI, "serve", "--data", dir, "--port", "0", "--json"], {
    env: { ...process.env, ...(crashAt ? { SIFT_CRASH_AT: crashAt } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const line = buf.split("\n").find((l) => l.includes("listening"));
      if (line) resolve((JSON.parse(line) as { listening: string }).listening);
    });
    proc.on("exit", (code) => reject(new Error(`server exited before listening (code ${code})`)));
  });
  return { proc, url, exited };
}

interface SentBatch { id: string; created: number; records: LogRecord[]; status: "acked" | "unknown" }

async function send(url: string, b: SentBatch): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", "x-sift-batch-id": b.id, "x-sift-batch-created": String(b.created) },
      body: Buffer.from(encodeRequest(b.records)),
    });
    await res.arrayBuffer();
    return res.status === 200;
  } catch {
    return false;
  }
}

let seq = 0;
function makeBatch(size: number): SentBatch {
  const records: LogRecord[] = [];
  for (let i = 0; i < size; i++) {
    const n = seq++;
    const service = ["frontend", "cart", "checkout", "payment"][n % 4]!;
    const body = n % 11 === 0 ? `error: call to payment failed seq=${n} after ${n % 900}ms` : `request seq=${n} served in ${n % 300}ms status 200`;
    records.push({ tsNs: String(1_705_354_566_000_000_000n + BigInt(n) * 1_000_000n), service, body });
  }
  return { id: randomUUID(), created: Date.now(), records, status: "unknown" };
}

async function loadUntilDead(server: Server, batches: SentBatch[], size: number, killAfterMs: number | null): Promise<void> {
  let dead = false;
  void server.exited.then(() => { dead = true; });
  if (killAfterMs !== null) setTimeout(() => server.proc.kill("SIGKILL"), killAfterMs);
  const worker = async () => {
    while (!dead) {
      const b = makeBatch(size);
      batches.push(b);
      if (await send(server.url, b)) b.status = "acked";
      else if (dead) return;
    }
  };
  // a crash point may never fire if its step is not reached; cap each run
  const cap = setTimeout(() => server.proc.kill("SIGKILL"), 8000);
  await Promise.all([worker(), worker(), worker(), worker()]);
  clearTimeout(cap);
  await server.exited;
}

/** Every stored line, reconstructed by the server from template + params, counted by its seq. */
async function storedSeqs(url: string): Promise<Map<number, number>> {
  const res = await fetch(`${url}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql: "select template_id, template_version, params, verbatim from logs", reconstruct: true }),
  });
  const { rows } = (await res.json()) as { rows: { line: string }[] };
  const counts = new Map<number, number>();
  for (const r of rows) {
    const m = /seq=(\d+)/.exec(r.line);
    if (!m) throw new Error(`stored line without a seq: ${r.line}`);
    const n = Number(m[1]);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return counts;
}

async function oneRun(i: number, size: number) {
  const dir = await mkdtemp(join(tmpdir(), "sift-crash-"));
  const transition = i % 2 === 1;
  const point = POINTS[Math.floor(i / 2) % POINTS.length]!;
  const crashAt = transition ? `${point}:${1 + Math.floor(rand() * 3)}` : undefined;
  const killAfter = transition ? null : 300 + Math.floor(rand() * 2500);
  const batches: SentBatch[] = [];
  const first = await startServer(dir, crashAt);
  await loadUntilDead(first, batches, size, killAfter);
  const crashedBy = transition ? crashAt : `random kill at ${killAfter} ms`;

  const second = await startServer(dir);
  const unknown = batches.filter((b) => b.status === "unknown");
  for (const b of unknown) if (await send(second.url, b)) b.status = "acked";
  const counts = await storedSeqs(second.url);
  second.proc.kill("SIGTERM");
  await second.exited;
  await rm(dir, { recursive: true, force: true });

  let lost = 0;
  let duplicated = 0;
  let ackedRecords = 0;
  for (const b of batches) {
    for (const r of b.records) {
      const n = Number(/seq=(\d+)/.exec(r.body)![1]);
      const c = counts.get(n) ?? 0;
      if (b.status === "acked") {
        ackedRecords += 1;
        if (c === 0) lost += 1;
      }
      if (c > 1) duplicated += 1;
    }
  }
  return { run: i, crashedBy, batches: batches.length, unknownBeforeRetry: unknown.length, ackedRecords, lost, duplicated };
}

const runs = Number(values.runs);
const size = Number(values.batch);
const results = [];
const started = Date.now();
for (let i = 0; i < runs; i++) {
  const r = await oneRun(i, size);
  results.push(r);
  process.stdout.write(`run ${i}: ${r.crashedBy}, acked ${r.ackedRecords}, lost ${r.lost}, duplicated ${r.duplicated}\n`);
}
const summary = {
  runs,
  recordsAcked: results.reduce((s, r) => s + r.ackedRecords, 0),
  lost: results.reduce((s, r) => s + r.lost, 0),
  duplicated: results.reduce((s, r) => s + r.duplicated, 0),
  byCrash: Object.fromEntries(
    ["random", ...POINTS].map((p) => [p, results.filter((r) => (p === "random" ? r.crashedBy.startsWith("random") : r.crashedBy.startsWith(p))).length]),
  ),
  seconds: Math.round((Date.now() - started) / 1000),
  machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30), node: process.versions.node, platform: process.platform },
  claim: "process crash (SIGKILL); power loss not tested",
  results,
};
await mkdir(dirname(values.out!), { recursive: true });
await writeFile(values.out!, JSON.stringify(summary, null, 2) + "\n");
process.stdout.write(`\n${runs} runs: ${summary.recordsAcked} acked records, ${summary.lost} lost, ${summary.duplicated} duplicated\n`);
if (summary.lost || summary.duplicated) process.exitCode = 1;
