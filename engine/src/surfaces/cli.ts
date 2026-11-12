#!/usr/bin/env node
/**
 * sift: command-line surface. Non-interactive; every command takes --json.
 * Exit codes: 0 ok, 1 unexpected, 2 usage, 3 input or environment.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_RANK_CONFIG, rank, type RankConfig } from "../detect/rank.js";
import { llmFromEnv } from "../detect/investigate.js";
import { runWatch } from "../detect/run.js";
import { DEFAULT_WATCH_CONFIG, type WatchConfig } from "../detect/watch.js";
import { SiftError } from "../errors.js";
import { LogStore } from "../logstore/store.js";
import { readLogFile, replayDirect, replayHttp } from "./replay.js";
import { buildServer } from "./server.js";

const HELP = `sift: logs-only observability engine

Commands:
  sift serve  [--data DIR] [--host 127.0.0.1] [--port 4318]   OTLP/HTTP intake + query API
  sift replay --logs FILE (--data DIR | --url URL)             replay a Parquet log file
  sift rank   --data DIR --at UNIX_SECONDS                     rank likely root-cause services
  sift rca    --logs FILE --at UNIX_SECONDS [--data DIR]       replay into a fresh store, then rank
  sift watch  --logs FILE [--no-llm] [--max-llm N] [--durable] forward-only sensors + investigation
  sift worker                                                  Temporal worker for durable investigations
  sift doctor                                                  check prerequisites

Common flags: --json (machine-readable output), --config FILE (ranker config JSON)
Run 'sift <command> --help' for an example.`;

const EXAMPLES: Record<string, string> = {
  serve: "sift serve --data .sift/data --port 4318",
  replay: "sift replay --logs data/rcaeval/hf/re2ob_checkoutservice_cpu_1/logs.parquet --url http://127.0.0.1:4318",
  rank: "sift rank --data .sift/data --at 1705354566 --json",
  rca: "sift rca --logs fixtures/demo/logs.parquet --at 1731905504 --json",
  watch: "SIFT_LLM_BASE_URL=http://127.0.0.1:8090/v1 sift watch --logs fixtures/demo/logs.parquet --json",
  doctor: "sift doctor --json",
  worker: "SIFT_LLM_BASE_URL=http://127.0.0.1:8090/v1 sift worker",
};

const options = {
  data: { type: "string" },
  logs: { type: "string" },
  url: { type: "string" },
  at: { type: "string" },
  host: { type: "string", default: "127.0.0.1" },
  port: { type: "string", default: "4318" },
  config: { type: "string" },
  batch: { type: "string", default: "2000" },
  json: { type: "boolean", default: false },
  keep: { type: "boolean", default: false },
  "no-llm": { type: "boolean", default: false },
  durable: { type: "boolean", default: false },
  "run-id": { type: "string" },
  "max-llm": { type: "string", default: "8" },
  help: { type: "boolean", default: false },
} as const;

type Values = { [K in keyof typeof options]?: (typeof options)[K]["type"] extends "boolean" ? boolean : string };

function need(v: Values, key: keyof Values, cmd: string): string {
  const x = v[key];
  if (typeof x !== "string" || !x) {
    throw new SiftError("SIFT-E401", `sift ${cmd} needs --${key}`, `example: ${EXAMPLES[cmd]}`);
  }
  return x;
}

async function loadConfig(path: string | undefined): Promise<RankConfig> {
  if (!path) return DEFAULT_RANK_CONFIG;
  try {
    return { ...DEFAULT_RANK_CONFIG, ...(JSON.parse(await readFile(path, "utf8")) as Partial<RankConfig>) };
  } catch (e) {
    throw new SiftError("SIFT-E104", `ranker config ${path} is unreadable: ${String(e)}`, "pass a JSON file with RankConfig fields, or omit --config");
  }
}

function at(v: Values, cmd: string): number {
  const n = Number(need(v, "at", cmd));
  if (!Number.isInteger(n)) throw new SiftError("SIFT-E401", `--at must be unix seconds, got ${v.at}`, `example: ${EXAMPLES[cmd]}`);
  return n;
}

function out(v: Values, obj: unknown, text: () => string): void {
  process.stdout.write(v.json ? `${JSON.stringify(obj, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}\n` : `${text()}\n`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const { values: v } = parseArgs({ args: rest, options, allowPositionals: false }) as { values: Values };
  if (!cmd || cmd === "--help" || cmd === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (v.help) {
    process.stdout.write(`example: ${EXAMPLES[cmd] ?? HELP}\n`);
    return;
  }
  switch (cmd) {
    case "serve": {
      const store = await LogStore.open(v.data ?? ".sift/data", { flushIntervalMs: 1000, compactEveryFlushes: 10 });
      const app = buildServer(store);
      const addr = await app.listen({ host: v.host ?? "127.0.0.1", port: Number(v.port) });
      out(v, { listening: addr, data: v.data ?? ".sift/data", recovered: store.wal.recovery, replayedFrames: store.stats.replayedFrames },
        () => `sift listening on ${addr} (OTLP/HTTP: POST ${addr}/v1/logs)`);
      const stop = async () => {
        await app.close();
        await store.close();
        process.exit(0);
      };
      process.on("SIGTERM", () => void stop());
      process.on("SIGINT", () => void stop());
      return;
    }
    case "replay": {
      const records = await readLogFile(need(v, "logs", "replay"));
      if (v.url) {
        const r = await replayHttp(v.url, records, Number(v.batch));
        out(v, { records: records.length, ...r }, () => `sent ${records.length} records in ${r.batches} batches (${r.retries} retries)`);
        return;
      }
      const store = await LogStore.open(need(v, "data", "replay"));
      await replayDirect(store, records, Number(v.batch));
      await store.compact();
      await store.close();
      out(v, { records: records.length }, () => `stored ${records.length} records`);
      return;
    }
    case "rank": {
      const store = await LogStore.open(need(v, "data", "rank"));
      const result = await rank(store, at(v, "rank"), await loadConfig(v.config));
      await store.close();
      out(v, result, () => formatRanking(result.ranking));
      return;
    }
    case "rca": {
      const t = at(v, "rca");
      const cfg = await loadConfig(v.config);
      const records = await readLogFile(need(v, "logs", "rca"));
      const dir = v.data ?? (await mkdtemp(join(tmpdir(), "sift-rca-")));
      const started = performance.now();
      const store = await LogStore.open(dir);
      try {
        await replayDirect(store, records, Number(v.batch));
        const ingestMs = performance.now() - started;
        const result = await rank(store, t, cfg);
        out(v, { ...result, records: records.length, templates: store.miner.size, ingestMs: Math.round(ingestMs) },
          () => formatRanking(result.ranking));
      } finally {
        await store.close();
        if (!v.data && !v.keep) await rm(dir, { recursive: true, force: true });
      }
      return;
    }
    case "watch": {
      const records = await readLogFile(need(v, "logs", "watch"));
      let cfg: WatchConfig = DEFAULT_WATCH_CONFIG;
      if (v.config) {
        try {
          cfg = { ...cfg, ...(JSON.parse(await readFile(v.config, "utf8")) as Partial<WatchConfig>) };
        } catch (e) {
          throw new SiftError("SIFT-E104", `watch config ${v.config} is unreadable: ${String(e)}`, "pass a JSON file with WatchConfig fields, or omit --config");
        }
      }
      const llm = v["no-llm"] ? null : llmFromEnv();
      if (v.durable) {
        // gate in process; model call and issue in a Temporal workflow per gate-passed signal
        const { connectClient, startInvestigation, waitAll } = await import("../durable/worker.js");
        const client = await connectClient();
        const runId = v["run-id"] ?? `run-${Date.now()}`;
        const ids: string[] = [];
        const services = new Set<string>();
        for (const r of records) services.add(r.service);
        const result = await runWatch(records, cfg, {
          llm: null,
          maxLlmCalls: 0,
          onInvestigation: async (inv) => {
            if (!inv.gate.pass) return;
            ids.push(await startInvestigation(client, {
              runId, stableName: `${inv.signal.service}:${inv.signal.sensor}`, signal: inv.signal,
              gatePass: true, evidence: inv.evidence, services: [...services],
            }));
          },
        });
        const outcomes = await waitAll(client, ids);
        out(v, { runId, signals: result.investigations.length, workflows: ids.length, outcomes }, () =>
          `run ${runId}: ${result.investigations.length} signals, ${ids.length} workflows, ${outcomes.filter((o) => o.issueCreated).length} issues opened`);
        await client.connection.close();
        return;
      }
      const result = await runWatch(records, cfg, { llm, maxLlmCalls: Number(v["max-llm"] ?? 8) });
      out(v, { config: cfg, model: llm?.model ?? null, ...result }, () =>
        result.investigations.map((i) => {
          const verdict = i.llm?.verdict ? `llm ${i.llm.verdict}` : i.llmSkipped ?? `llm ${i.llm?.failure}`;
          return `${new Date(i.signal.at * 1000).toISOString().slice(11, 19)} ${i.signal.service.padEnd(22)} ${i.signal.sensor.padEnd(9)} gate ${i.gate.pass ? "pass" : "hold"}  ${verdict}`;
        }).join("\n") || "no signals");
      return;
    }
    case "worker": {
      const { runWorker } = await import("../durable/worker.js");
      await runWorker();
      return;
    }
    case "doctor": {
      const checks = await doctor();
      out(v, checks, () => checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}${c.ok ? "" : `\n     fix: ${c.fix}`}`).join("\n"));
      if (checks.some((c) => !c.ok && c.required)) process.exitCode = 3;
      return;
    }
    default:
      throw new SiftError("SIFT-E401", `unknown command ${cmd}`, "run: sift --help");
  }
}

function formatRanking(ranking: { service: string; score: number; evidence: { kind: string; template: string; before: number; after: number; example: string | null }[] }[]): string {
  if (!ranking.length) return "no service shows log evidence in the window";
  return ranking.slice(0, 5).map((r, i) => {
    const ev = r.evidence.map((e) => `      ${e.kind.padEnd(7)} ${e.before}→${e.after}  ${(e.example ?? e.template).slice(0, 110)}`).join("\n");
    return `${i + 1}. ${r.service}  (score ${r.score.toFixed(2)})\n${ev}`;
  }).join("\n");
}

interface Check { name: string; ok: boolean; required: boolean; detail: string; fix: string }

async function doctor(): Promise<Check[]> {
  const major = Number(process.versions.node.split(".")[0]);
  const checks: Check[] = [
    { name: "node", ok: major >= 24, required: true, detail: process.versions.node, fix: "install Node 24 or newer" },
  ];
  const llm = process.env.SIFT_LLM_BASE_URL;
  checks.push({ name: "llm endpoint", ok: !!llm, required: false, detail: llm ? "SIFT_LLM_BASE_URL is set" : "SIFT_LLM_BASE_URL not set (LLM rung skipped)",
    fix: "set SIFT_LLM_BASE_URL to an OpenAI-compatible server, e.g. mlx_lm.server or Ollama" });
  return checks;
}

main(process.argv.slice(2)).catch((e: unknown) => {
  if (e instanceof SiftError) {
    process.stderr.write(process.argv.includes("--json") ? `${JSON.stringify(e.problem())}\n` : `${e.render()}\n`);
    process.exitCode = e.code === "SIFT-E401" ? 2 : ["SIFT-E104", "SIFT-E202"].includes(e.code) ? 3 : 1;
    return;
  }
  const trace = join(tmpdir(), `sift-crash-${Date.now()}.log`);
  void import("node:fs").then((fs) => fs.writeFileSync(trace, String((e as Error)?.stack ?? e)));
  process.stderr.write(`SIFT-E500 unexpected failure: ${String((e as Error)?.message ?? e)}\ntrace: ${trace}\nfix: rerun with the same arguments; if it repeats, open an issue with the trace file\n`);
  process.exitCode = 1;
});
