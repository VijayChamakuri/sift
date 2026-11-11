/**
 * Write-ahead log: the source of truth. Everything else in the store is derived from it.
 *
 *   frame = [u32 LE payload length][u32 LE crc32(payload)][payload: UTF-8 JSON]
 *   payload = { b: batchId | null, c: createdMs | null, t: appendedMs, r: LogRecord[] }
 *
 * Group commit: appends queue up while one write+fsync is in flight; the next flush takes the
 * whole queue as one write and one fsync. A batch is acknowledged only after the fsync that
 * covers its frame returns, so an acked batch survives a process crash (kill -9). Power-loss
 * durability on macOS would also need F_FULLFSYNC and is not claimed.
 *
 * Duplicates: a batch with an id is written once. The id index is rebuilt from the frames on
 * open, so it survives a crash together with the data. Ids are remembered for `horizonMs`; a
 * retry whose first attempt (`createdMs`) is older than that is rejected (SIFT-E105) rather
 * than risk being written twice.
 */
import { open, type FileHandle } from "node:fs/promises";
import { crc32 } from "node:zlib";

import { SiftError } from "../errors.js";
import type { AppendResult, Batch, LogRecord } from "../types.js";
import { crashPoint } from "./crashpoints.js";

const HEADER = 8;

export interface WalOptions {
  /** Reject new appends once this many bytes are queued and not yet durable. */
  maxPendingBytes?: number;
  /** How long batch ids are remembered for deduplication. */
  horizonMs?: number;
  now?: () => number;
}

export interface WalFrame {
  start: number;
  end: number;
  batchId: string | null;
  appendedMs: number;
  records: LogRecord[];
}

interface Pending {
  frame: Buffer;
  batchId: string | null;
  records: number;
  data: LogRecord[];
  resolve: (r: AppendResult) => void;
  reject: (e: unknown) => void;
}

export interface RecoveryReport {
  frames: number;
  bytes: number;
  truncatedBytes: number;
}

export class Wal {
  private fh!: FileHandle;
  private size = 0;
  private queue: Pending[] = [];
  private queuedBytes = 0;
  private flushing: Promise<void> | null = null;
  private readonly seen = new Map<string, { end: number; at: number }>();
  private readonly inflight = new Map<string, Promise<AppendResult>>();
  private readonly maxPendingBytes: number;
  private readonly horizonMs: number;
  private readonly now: () => number;
  recovery: RecoveryReport = { frames: 0, bytes: 0, truncatedBytes: 0 };
  /**
   * Called synchronously, in WAL order, for each frame once it is durable and before its
   * append resolves. Derived state is built here, so replaying the WAL rebuilds it exactly.
   */
  onDurable: ((records: LogRecord[], end: number) => void) | null = null;

  private constructor(readonly path: string, opts: WalOptions) {
    this.maxPendingBytes = opts.maxPendingBytes ?? 64 * 1024 * 1024;
    this.horizonMs = opts.horizonMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  /** Open (creating if needed), drop a torn tail, and rebuild the dedup index from the frames. */
  static async open(path: string, opts: WalOptions = {}): Promise<Wal> {
    const wal = new Wal(path, opts);
    wal.fh = await open(path, "a+");
    const { size } = await wal.fh.stat();
    let good = 0;
    let frames = 0;
    for await (const f of wal.scan(0, size)) {
      good = f.end;
      frames += 1;
      if (f.batchId) wal.seen.set(f.batchId, { end: f.end, at: f.appendedMs });
    }
    if (good < size) {
      // only an un-acked, partially written tail can be torn: acks wait for fsync
      await wal.fh.truncate(good);
      await wal.fh.sync();
    }
    wal.size = good;
    wal.recovery = { frames, bytes: good, truncatedBytes: size - good };
    return wal;
  }

  get end(): number {
    return this.size;
  }

  append(batch: Batch, createdMs?: number): Promise<AppendResult> {
    const id = batch.batchId ?? null;
    if (id) {
      this.evict();
      const hit = this.seen.get(id);
      if (hit) return Promise.resolve({ offset: hit.end, records: batch.records.length, duplicate: true });
      const pending = this.inflight.get(id);
      if (pending) return pending.then((r) => ({ ...r, duplicate: true }));
      if (createdMs !== undefined && this.now() - createdMs > this.horizonMs) {
        return Promise.reject(
          new SiftError(
            "SIFT-E105",
            `batch ${id} was first sent ${Math.round((this.now() - createdMs) / 1000)}s ago, beyond the ${this.horizonMs / 1000}s dedup horizon`,
            "send it as a new batch with a new batch id, or check the sender's retry policy",
            { httpStatus: 409 },
          ),
        );
      }
    }
    const payload = Buffer.from(JSON.stringify({ b: id, c: createdMs ?? null, t: this.now(), r: batch.records }));
    if (this.queuedBytes + payload.length > this.maxPendingBytes) {
      return Promise.reject(
        new SiftError(
          "SIFT-E103",
          `write-ahead log is behind: ${this.queuedBytes} bytes queued, limit ${this.maxPendingBytes}`,
          "retry after the Retry-After interval; the sender should back off",
          { retryable: true, httpStatus: 429 },
        ),
      );
    }
    const frame = Buffer.allocUnsafe(HEADER + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    frame.writeUInt32LE(crc32(payload), 4);
    payload.copy(frame, HEADER);
    const result = new Promise<AppendResult>((resolve, reject) => {
      this.queue.push({ frame, batchId: id, records: batch.records.length, data: batch.records, resolve, reject });
    });
    this.queuedBytes += frame.length;
    if (id) {
      this.inflight.set(id, result);
      result.finally(() => this.inflight.delete(id)).catch(() => undefined);
    }
    this.kick();
    return result;
  }

  /** Resolves when everything queued so far is durable. */
  async drain(): Promise<void> {
    while (this.flushing || this.queue.length) {
      this.kick();
      await this.flushing;
    }
  }

  async close(): Promise<void> {
    await this.drain();
    await this.fh.close();
  }

  /** Frames from `from` (a frame boundary) to `to`; stops at the first frame that fails its checksum. */
  async *scan(from: number, to?: number): AsyncGenerator<WalFrame> {
    const limit = to ?? this.size;
    const chunk = 4 * 1024 * 1024;
    let buf = Buffer.alloc(0);
    let bufStart = from;
    let readPos = from;
    while (true) {
      if (buf.length < HEADER || buf.length < HEADER + buf.readUInt32LE(0)) {
        if (readPos >= limit) return;
        const want = Math.min(chunk, limit - readPos);
        const next = Buffer.allocUnsafe(want);
        const { bytesRead } = await this.fh.read(next, 0, want, readPos);
        if (bytesRead === 0) return;
        readPos += bytesRead;
        buf = Buffer.concat([buf, next.subarray(0, bytesRead)]);
        continue;
      }
      const len = buf.readUInt32LE(0);
      const crc = buf.readUInt32LE(4);
      const payload = buf.subarray(HEADER, HEADER + len);
      if (crc32(payload) !== crc) return;
      let parsed: { b: string | null; t: number; r: LogRecord[] };
      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch {
        return;
      }
      const start = bufStart;
      const end = bufStart + HEADER + len;
      yield { start, end, batchId: parsed.b, appendedMs: parsed.t, records: parsed.r };
      buf = buf.subarray(HEADER + len);
      bufStart = end;
    }
  }

  private evict(): void {
    const cutoff = this.now() - this.horizonMs;
    for (const [id, v] of this.seen) {
      if (v.at >= cutoff) break; // insertion order is append order
      this.seen.delete(id);
    }
  }

  private kick(): void {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = this.flush().finally(() => {
      this.flushing = null;
      if (this.queue.length) this.kick();
    });
  }

  private async flush(): Promise<void> {
    const group = this.queue;
    this.queue = [];
    const buf = Buffer.concat(group.map((p) => p.frame));
    try {
      let written = 0;
      while (written < buf.length) {
        const { bytesWritten } = await this.fh.write(buf, written, buf.length - written, this.size + written);
        written += bytesWritten;
      }
      crashPoint("wal.beforeFsync");
      await this.fh.datasync();
      crashPoint("wal.afterFsync");
    } catch (e) {
      this.queuedBytes -= buf.length;
      const err = new SiftError("SIFT-E202", `write-ahead log write failed at ${this.path}: ${String(e)}`,
        "check free disk space and permissions on the data directory, then restart", { httpStatus: 503 });
      for (const p of group) p.reject(err);
      return;
    }
    let pos = this.size;
    const at = this.now();
    for (const p of group) {
      pos += p.frame.length;
      if (p.batchId) this.seen.set(p.batchId, { end: pos, at });
      this.onDurable?.(p.data, pos);
    }
    this.size = pos;
    this.queuedBytes -= buf.length;
    pos = this.size - buf.length;
    for (const p of group) {
      pos += p.frame.length;
      p.resolve({ offset: pos, records: p.records, duplicate: false });
    }
  }
}
