/**
 * `pnpm demo`: replay one real incident (a bundled RCAEval Dev case) through the full path:
 * OTLP/HTTP intake → WAL → template mining → Parquet → ranking. No Docker, no download, no model.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_RANK_CONFIG, rank, type RankConfig } from "../detect/rank.js";
import { LogStore } from "../logstore/store.js";
import { readLogFile, replayHttp } from "./replay.js";
import { buildServer } from "./server.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(ROOT, "fixtures", "demo");
const SPEED = Number(process.env.SIFT_DEMO_SPEED ?? 60); // 10 minutes of logs in ~10 s

interface CaseInfo { case: string; inject_time: number; root_cause_service: string; fault: string; lines: number; source: string }

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

async function main(): Promise<void> {
  const started = performance.now();
  const info = JSON.parse(await readFile(join(FIXTURE, "case.json"), "utf8")) as CaseInfo;
  let cfg: RankConfig = DEFAULT_RANK_CONFIG;
  try {
    cfg = { ...cfg, ...(JSON.parse(await readFile(join(ROOT, "configs", "rank.json"), "utf8")) as Partial<RankConfig>) };
  } catch {
    // default config
  }
  const records = await readLogFile(join(FIXTURE, "logs.parquet"));
  const dir = await mkdtemp(join(tmpdir(), "sift-demo-"));
  const store = await LogStore.open(dir, { flushIntervalMs: 1000 });
  const app = buildServer(store);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });

  process.stdout.write(`${bold("Sift demo")}  ${info.case} (RCAEval, Dev set)\n`);
  process.stdout.write(dim(`${records.length} real log lines, replayed at ${SPEED}x through OTLP/HTTP ${url}/v1/logs\n\n`));

  // pace by event time: one chunk per 30 s of log time
  const t0 = BigInt(records[0]!.tsNs);
  const chunkNs = 30_000_000_000n;
  let i = 0;
  while (i < records.length) {
    const end = BigInt(records[i]!.tsNs) - ((BigInt(records[i]!.tsNs) - t0) % chunkNs) + chunkNs;
    const chunk: typeof records = [];
    while (i < records.length && BigInt(records[i]!.tsNs) < end) chunk.push(records[i++]!);
    await replayHttp(url, chunk, 1000);
    const perService = new Map<string, number>();
    for (const r of chunk) perService.set(r.service, (perService.get(r.service) ?? 0) + 1);
    const at = Number((end - chunkNs) / 1_000_000_000n);
    const mark = at >= info.inject_time ? "after " : "before";
    const line = [...perService].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, n]) => `${s} ${n}`).join("  ");
    process.stdout.write(`${dim(new Date(at * 1000).toISOString().slice(11, 19))} ${mark} ${line}\n`);
    await new Promise((r) => setTimeout(r, Number(chunkNs / 1_000_000n) / SPEED));
  }

  const result = await rank(store, info.inject_time, cfg);
  process.stdout.write(`\n${bold("Ranked root-cause candidates")} (logs only, alarm at ${new Date(info.inject_time * 1000).toISOString().slice(11, 19)})\n`);
  result.ranking.slice(0, 3).forEach((r, k) => {
    process.stdout.write(`${k + 1}. ${bold(r.service)}  score ${r.score.toFixed(2)}\n`);
    for (const e of r.evidence) {
      process.stdout.write(`     ${e.kind.padEnd(7)} ${String(e.before).padStart(5)} → ${String(e.after).padEnd(5)} ${(e.example ?? e.template).slice(0, 100)}\n`);
    }
  });
  const pos = result.ranking.findIndex((r) => r.service === info.root_cause_service);
  process.stdout.write(`\nground truth: ${bold(info.root_cause_service)} (${info.fault} fault) → ranked ${pos >= 0 ? `#${pos + 1}` : "not ranked"}\n`);
  process.stdout.write(dim(`This is one Dev case. Results across all cases: README.md. Data: ${info.source}\n`));
  process.stdout.write(dim(`finished in ${((performance.now() - started) / 1000).toFixed(1)} s\n`));

  await app.close();
  await store.close();
  await rm(dir, { recursive: true, force: true });
}

main().catch((e: unknown) => {
  process.stderr.write(`${String((e as Error)?.message ?? e)}\nfix: run 'pnpm install' at the repo root, then 'pnpm demo'\n`);
  process.exitCode = 1;
});
