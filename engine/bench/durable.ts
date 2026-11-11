/**
 * Durable investigations survive a worker crash.
 *
 * For each crash point (the model call, the issue write):
 *   1. start a worker that SIGKILLs itself the 2nd time it reaches that point
 *   2. run `sift watch --durable` on the bundled demo incident: one workflow per gate-passed signal
 *   3. when the worker dies, start a clean worker; Temporal retries the interrupted activity
 *   4. check: every workflow completed, and Postgres holds exactly one issue per opened stable name
 *
 * Needs: docker compose -f deploy/docker-compose.yml up -d, and the model server for the LLM rung.
 * Usage: tsx bench/durable.ts --out ../results/infra/durable.json
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import pg from "pg";

const CLI = fileURLToPath(new URL("../dist/surfaces/cli.js", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../../fixtures/demo/logs.parquet", import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string", default: "../results/infra/durable.json" } } });

function startWorker(crashAt?: string): { proc: ChildProcess; exited: Promise<number | null>; ready: Promise<void> } {
  const proc = spawn(process.execPath, [CLI, "worker"], {
    env: { ...process.env, ...(crashAt ? { SIFT_CRASH_AT: crashAt } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((r) => proc.on("exit", (code, signal) => r(signal ? -1 : code)));
  const ready = new Promise<void>((resolve, reject) => {
    proc.stdout!.on("data", (d: Buffer) => d.toString().includes('"ready"') && resolve());
    proc.on("exit", () => reject(new Error("worker exited before ready")));
  });
  return { proc, exited, ready };
}

async function scenario(point: "activity.llmVerdict" | "activity.openIssue") {
  const runId = `durable-${point}-${Date.now()}`;
  let worker = startWorker(`${point}:2`);
  await worker.ready;
  let restarts = 0;
  let crashed = false;
  void worker.exited.then(async () => {
    crashed = true;
    restarts += 1;
    worker = startWorker();
    await worker.ready.catch(() => undefined);
  });
  const watch = spawn(process.execPath, [CLI, "watch", "--logs", FIXTURE, "--durable", "--run-id", runId, "--json"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  watch.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
  let stderr = "";
  watch.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  const code = await new Promise<number | null>((r) => watch.on("exit", r));
  if (code !== 0) throw new Error(`watch failed: ${stderr}`);
  const result = JSON.parse(stdout) as { workflows: number; outcomes: { stableName: string; issueCreated: boolean; decision: string }[] };
  const db = new pg.Client({ connectionString: process.env.SIFT_PG_URL ?? "postgres://sift:sift-local-only@127.0.0.1:5433/sift" });
  await db.connect();
  const rows = (await db.query("select stable_name, count(*)::int n from issues where run_id = $1 group by 1", [runId])).rows as { stable_name: string; n: number }[];
  await db.end();
  worker.proc.kill("SIGTERM");
  const opened = new Set(result.outcomes.filter((o) => o.decision === "open").map((o) => o.stableName));
  const stored = new Map(rows.map((r) => [r.stable_name, r.n]));
  return {
    crashPoint: point,
    workerCrashed: crashed,
    workerRestarts: restarts,
    workflows: result.workflows,
    workflowsCompleted: result.outcomes.length,
    openDecisions: opened.size,
    issueRows: rows.reduce((s, r) => s + r.n, 0),
    duplicateIssues: rows.filter((r) => r.n > 1).length,
    openWithoutIssue: [...opened].filter((n) => !stored.has(n)).length,
  };
}

const results = [];
for (const point of ["activity.llmVerdict", "activity.openIssue"] as const) {
  const r = await scenario(point);
  results.push(r);
  process.stdout.write(`${JSON.stringify(r)}\n`);
}
const ok = results.every((r) => r.workerCrashed && r.workflowsCompleted === r.workflows && r.duplicateIssues === 0 && r.openWithoutIssue === 0);
await mkdir(dirname(values.out!), { recursive: true });
await writeFile(values.out!, `${JSON.stringify({ ok, model: process.env.SIFT_LLM_MODEL ?? "mlx-community/Qwen2.5-3B-Instruct-4bit", results, measuredAt: new Date().toISOString() }, null, 2)}\n`);
process.stdout.write(ok ? "durable investigations: OK\n" : "durable investigations: FAILED\n");
if (!ok) process.exitCode = 1;
