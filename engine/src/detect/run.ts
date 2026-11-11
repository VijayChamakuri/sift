/**
 * Run the watcher over a log file as a discrete-event simulation on event time.
 *
 * Investigations are queued at their firing time t and resolved at the first tick whose end is
 * at or after t + gateSeconds, so the counts they read contain exactly the lines that had arrived by
 * then. Signals whose cut-off lies beyond the end of the recording are resolved with what exists and
 * marked censored.
 */
import { TemplateMiner } from "../templates/drain.js";
import type { LogRecord } from "../types.js";
import { askModel, gate, gatherEvidence, type EvidenceItem, type GateResult, type LlmClient, type LlmVerdict } from "./investigate.js";
import { Counts, readSensors, replayBins, type Signal, type WatchConfig } from "./watch.js";

export interface Investigation {
  signal: Signal;
  gate: GateResult;
  evidence: EvidenceItem[];
  llm: LlmVerdict | null; // null: gate did not pass, model not configured, or call cap reached
  llmSkipped: "gate_hold" | "no_model" | "cap" | null;
  resolvedAt: number; // event time the decision was made (t + gateSeconds, or end of data)
  censored: boolean;
}

export interface WatchResult {
  start: number;
  end: number;
  lines: number;
  investigations: Investigation[];
  llmCalls: number;
  llmMs: number;
}

export interface RunOptions {
  llm: LlmClient | null;
  maxLlmCalls: number;
  /** Called after each investigation resolves (the Temporal path uses this to open issues). */
  onInvestigation?: (inv: Investigation) => Promise<void> | void;
}

export async function runWatch(records: LogRecord[], cfg: WatchConfig, opts: RunOptions): Promise<WatchResult> {
  const toSec = (r: LogRecord) => Number(BigInt(r.tsNs) / 1_000_000_000n);
  if (!records.length) return { start: 0, end: 0, lines: 0, investigations: [], llmCalls: 0, llmMs: 0 };
  const first = toSec(records[0]!);
  const start = first - (first % cfg.binSeconds);
  const end = toSec(records[records.length - 1]!);
  const counts = new Counts(start, cfg.binSeconds);
  const miner = new TemplateMiner();
  const signals: Signal[] = [];
  const lastFired = new Map<string, number>();
  const pending: Signal[] = [];
  const done: Investigation[] = [];
  let llmCalls = 0;
  let llmMs = 0;

  const resolve = async (s: Signal, at: number, censored: boolean) => {
    const g = gate(counts, s, cfg);
    const evidence = gatherEvidence(counts, s, cfg, signals);
    let llm: LlmVerdict | null = null;
    let llmSkipped: Investigation["llmSkipped"] = null;
    if (!g.pass) llmSkipped = "gate_hold";
    else if (!opts.llm) llmSkipped = "no_model";
    else if (llmCalls >= opts.maxLlmCalls) llmSkipped = "cap";
    else {
      llm = await askModel(opts.llm, s, evidence, new Set(counts.lines.keys()));
      llmCalls += 1;
      llmMs += llm.latencyMs;
    }
    const inv: Investigation = { signal: s, gate: g, evidence, llm, llmSkipped, resolvedAt: at, censored };
    done.push(inv);
    await opts.onInvestigation?.(inv);
  };

  for (const tick of replayBins(records, miner, counts)) {
    // resolve investigations whose evidence window has fully arrived
    for (let i = pending.length - 1; i >= 0; i--) {
      const s = pending[i]!;
      if (s.at + cfg.gateSeconds <= tick.endSec) {
        pending.splice(i, 1);
        await resolve(s, tick.endSec, false);
      }
    }
    if (tick.endSec - start < cfg.warmupSeconds) continue;
    for (const service of [...counts.lines.keys()].sort()) {
      for (const r of readSensors(counts, service, tick.bin, cfg)) {
        const key = `${service}:${r.kind}`;
        const last = lastFired.get(key);
        if (last !== undefined && tick.endSec - last < cfg.cooldownSeconds) continue;
        lastFired.set(key, tick.endSec);
        const s: Signal = {
          id: `${key}@${tick.endSec}`,
          service,
          sensor: r.kind,
          at: tick.endSec,
          value: Math.round(r.value * 100) / 100,
          detail: r.detail,
          ...(r.templateId !== undefined ? { templateId: r.templateId } : {}),
        };
        signals.push(s);
        pending.push(s);
      }
    }
  }
  for (const s of pending) await resolve(s, end, true);
  done.sort((a, b) => a.signal.at - b.signal.at || a.signal.id.localeCompare(b.signal.id));
  return { start, end, lines: records.length, investigations: done, llmCalls, llmMs };
}
