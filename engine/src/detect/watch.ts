/**
 * Forward-only watching: replay logs in event time, run sensors as data arrives, investigate what
 * fires, and open issues. No alarm time is given; every decision uses only lines that have arrived.
 *
 *   tick every binSeconds of event time (ticks advance even when nothing arrives, so silence shows)
 *     ├─ mine each arrived line online (same miner as storage), count per service and template
 *     ├─ sensors, per service, last windowSeconds against the baselineSeconds before it:
 *     │    rate      Poisson z of the line count against the baseline rate (floods and silence)
 *     │    errors    Poisson z of the error-line count against the baseline error rate
 *     │    new_error an error template the service has never written before, >= minNewErrors lines
 *     ├─ a firing becomes a signal; one signal per (service, sensor) per cooldown
 *     └─ each signal is investigated at its firing time t (see investigate.ts):
 *          gate  wait gateSeconds of event time, re-measure, open only if the change persists and is
 *                specific to the service (not a system-wide shift)
 *          llm   for gate-passed signals: a local model reads the evidence gathered up to
 *                t + gateSeconds and answers open or hold
 *
 * Evidence for an investigation started at t is cut at t + gateSeconds; nothing later is read.
 * Model latency is real time and never changes what evidence the investigation sees.
 */
import { TemplateMiner } from "../templates/drain.js";
import type { LogRecord } from "../types.js";
import { isErrorText } from "./rank.js";

export interface WatchConfig {
  binSeconds: number;
  windowSeconds: number;
  baselineSeconds: number;
  warmupSeconds: number;
  zThreshold: number;
  minNewErrors: number;
  cooldownSeconds: number;
  gateSeconds: number;
  minLines: number; // a service needs this many lines in the baseline before rate/error sensors run
}

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  binSeconds: 15,
  windowSeconds: 60,
  baselineSeconds: 300,
  warmupSeconds: 300,
  zThreshold: 4,
  minNewErrors: 3,
  cooldownSeconds: 120,
  gateSeconds: 60,
  minLines: 20,
};

export type SensorKind = "rate" | "errors" | "new_error";

export interface Signal {
  id: string;
  service: string;
  sensor: SensorKind;
  at: number; // unix seconds, event time of the tick that fired
  value: number; // z score, or line count for new_error
  detail: string;
  templateId?: number; // new_error: the template that fired
}

/** Per-service, per-bin counts that the sensors and the gate read. */
export class Counts {
  readonly lines = new Map<string, number[]>(); // service -> count per bin
  readonly errors = new Map<string, number[]>();
  readonly templates = new Map<string, Map<number, number[]>>(); // service -> template -> count per bin
  readonly firstSeenBin = new Map<string, Map<number, number>>(); // service -> template -> bin
  readonly examples = new Map<number, string>(); // template -> first example line
  readonly isError = new Map<number, boolean>();

  constructor(readonly startSec: number, readonly binSeconds: number) {}

  bin(sec: number): number {
    return Math.floor((sec - this.startSec) / this.binSeconds);
  }

  add(service: string, templateId: number, text: string, line: string, sec: number, err: boolean): void {
    const b = this.bin(sec);
    inc(this.lines, service, b);
    if (err) inc(this.errors, service, b);
    let per = this.templates.get(service);
    if (!per) this.templates.set(service, (per = new Map()));
    let arr = per.get(templateId);
    if (!arr) per.set(templateId, (arr = []));
    arr[b] = (arr[b] ?? 0) + 1;
    let first = this.firstSeenBin.get(service);
    if (!first) this.firstSeenBin.set(service, (first = new Map()));
    if (!first.has(templateId)) first.set(templateId, b);
    if (!this.examples.has(templateId)) this.examples.set(templateId, line);
    if (!this.isError.has(templateId)) this.isError.set(templateId, isErrorText(text));
  }

  /** Sum of a per-bin series over bins [from, to). */
  static sum(series: number[] | undefined, from: number, to: number): number {
    if (!series) return 0;
    let s = 0;
    for (let i = Math.max(0, from); i < to; i++) s += series[i] ?? 0;
    return s;
  }
}

function inc(m: Map<string, number[]>, key: string, b: number): void {
  let arr = m.get(key);
  if (!arr) m.set(key, (arr = []));
  arr[b] = (arr[b] ?? 0) + 1;
}

/** Poisson z of an observed count against an expected count. */
export function poissonZ(observed: number, expected: number): number {
  return (observed - expected) / Math.sqrt(expected + 1);
}

/** Sensor readings for one service at the end of bin `endBin` (exclusive). */
export interface Reading {
  kind: SensorKind;
  value: number;
  detail: string;
  templateId?: number;
}

export function readSensors(c: Counts, service: string, endBin: number, cfg: WatchConfig): Reading[] {
  const w = cfg.windowSeconds / cfg.binSeconds;
  const base = cfg.baselineSeconds / cfg.binSeconds;
  const out: Reading[] = [];
  const baseLines = Counts.sum(c.lines.get(service), endBin - w - base, endBin - w);
  if (baseLines >= cfg.minLines) {
    const expected = (baseLines / base) * w;
    const now = Counts.sum(c.lines.get(service), endBin - w, endBin);
    const z = poissonZ(now, expected);
    if (Math.abs(z) >= cfg.zThreshold) {
      out.push({ kind: "rate", value: z, detail: `${now} lines in ${cfg.windowSeconds}s, expected ${expected.toFixed(1)}` });
    }
    const baseErr = Counts.sum(c.errors.get(service), endBin - w - base, endBin - w);
    const expErr = (baseErr / base) * w;
    const nowErr = Counts.sum(c.errors.get(service), endBin - w, endBin);
    const ze = poissonZ(nowErr, expErr);
    if (ze >= cfg.zThreshold) {
      out.push({ kind: "errors", value: ze, detail: `${nowErr} error lines in ${cfg.windowSeconds}s, expected ${expErr.toFixed(1)}` });
    }
  }
  const first = c.firstSeenBin.get(service);
  const per = c.templates.get(service);
  if (first && per) {
    for (const [tid, fb] of first) {
      if (fb < endBin - w || fb >= endBin || !c.isError.get(tid)) continue;
      const n = Counts.sum(per.get(tid), fb, endBin);
      if (n >= cfg.minNewErrors) {
        out.push({ kind: "new_error", value: n, templateId: tid, detail: `new error template, ${n} lines: ${(c.examples.get(tid) ?? "").slice(0, 160)}` });
      }
    }
  }
  return out;
}

export interface Tick {
  bin: number;
  endSec: number;
}

/**
 * Replay records (sorted by event time) bin by bin. For each completed bin, `onTick` runs with the
 * counts so far. Records must already be in event-time order.
 */
export function* replayBins(records: LogRecord[], miner: TemplateMiner, counts: Counts): Generator<Tick> {
  if (!records.length) return;
  const toSec = (r: LogRecord) => Number(BigInt(r.tsNs) / 1_000_000_000n);
  const last = toSec(records[records.length - 1]!);
  let i = 0;
  for (let bin = 0; counts.startSec + bin * counts.binSeconds <= last; bin++) {
    const endSec = counts.startSec + (bin + 1) * counts.binSeconds;
    while (i < records.length && toSec(records[i]!) < endSec) {
      const r = records[i++]!;
      const m = miner.mine(r.service, r.body);
      const text = m.templateId >= 0 ? miner.template(m.templateId) : r.body;
      counts.add(r.service, m.templateId, text, r.body, toSec(r), isErrorText(text, r.severity));
    }
    yield { bin: bin + 1, endSec };
  }
}
