/**
 * LogStore owns all persistent state: the WAL, the template registry snapshot, Parquet segments,
 * rollups and the DuckDB instance that queries them. Nothing else writes to the data directory.
 *
 *   append ─▶ WAL (fsync) ─▶ onDurable, in WAL order ─▶ mine template ─▶ hot rows (memory)
 *   flush  ─▶ hot rows ─▶ segment + rollup Parquet ─▶ template snapshot ─▶ manifest (atomic rename)
 *   open   ─▶ manifest ─▶ restore template snapshot ─▶ replay WAL from manifest.walOffset
 *
 * The manifest is the single commit boundary. Files not named in it are leftovers of a crash
 * and are deleted on open; anything after manifest.walOffset is rebuilt from the WAL, so the
 * derived state after recovery is what it would have been without the crash.
 *
 * Layout: segments are Parquet (zstd), one file per flush, compacted into one file per hour,
 * sorted by (service, ts). Rows store template_id + template_version and the parameters as their
 * original strings; a line that fits no template is stored verbatim.
 */
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

import { SiftError } from "../errors.js";
import { TemplateMiner, type TemplateInfo } from "../templates/drain.js";
import type { AppendResult, Batch, LogRecord } from "../types.js";
import { crashPoint, skipWalReplay } from "./crashpoints.js";
import { Wal, type WalOptions } from "./wal.js";

export interface StoreOptions extends WalOptions {
  /** Flush hot rows to Parquet every this many ms (0: only on demand). */
  flushIntervalMs?: number;
  /** With a flush interval, compact hot segments every this many flushes (0: never). */
  compactEveryFlushes?: number;
  memoryLimit?: string;
  threads?: number;
}

interface Manifest {
  version: 1;
  seq: number;
  walOffset: number;
  templates: string | null;
  segments: string[];
  rollups: string[];
}

interface Row {
  seq: number;
  tsNs: bigint;
  service: string;
  severity: string;
  templateId: number;
  version: number;
  params: string;
  verbatim: string | null;
}

const EMPTY: Manifest = { version: 1, seq: 0, walOffset: 0, templates: null, segments: [], rollups: [] };

export class LogStore {
  readonly miner: TemplateMiner;
  private manifest: Manifest;
  private hot: Row[] = [];
  private nextSeq = 0;
  private ingestedOffset: number;
  private timer: NodeJS.Timeout | null = null;
  private lock: Promise<void> = Promise.resolve();
  readonly stats = { ingested: 0, flushes: 0, replayedFrames: 0, removedOrphans: 0 };

  private constructor(
    readonly dir: string,
    readonly wal: Wal,
    private readonly db: DuckDBInstance,
    private readonly conn: DuckDBConnection,
    manifest: Manifest,
    miner: TemplateMiner,
  ) {
    this.manifest = manifest;
    this.miner = miner;
    this.ingestedOffset = manifest.walOffset;
  }

  static async open(dir: string, opts: StoreOptions = {}): Promise<LogStore> {
    try {
      for (const sub of ["", "segments", "rollups", "templates"]) await mkdir(join(dir, sub), { recursive: true });
    } catch (e) {
      throw new SiftError("SIFT-E202", `cannot create data directory ${dir}: ${String(e)}`,
        "choose a writable --data directory");
    }
    const manifest = await readManifest(dir);
    const miner = manifest.templates
      ? TemplateMiner.restore(JSON.parse(await readFile(join(dir, manifest.templates), "utf8")) as TemplateInfo[])
      : new TemplateMiner();
    const db = await DuckDBInstance.create(":memory:", {
      memory_limit: opts.memoryLimit ?? "2GB",
      threads: String(opts.threads ?? 4),
    });
    const conn = await db.connect();
    const wal = await Wal.open(join(dir, "wal.log"), opts);
    const store = new LogStore(dir, wal, db, conn, manifest, miner);
    store.nextSeq = await store.maxSeq();
    store.stats.removedOrphans = await store.removeOrphans();
    for await (const frame of wal.scan(manifest.walOffset)) {
      if (skipWalReplay) break;
      store.ingest(frame.records, frame.end);
      store.stats.replayedFrames += 1;
    }
    wal.onDurable = (records, end) => store.ingest(records, end);
    if (opts.flushIntervalMs) {
      const every = opts.compactEveryFlushes ?? 0;
      let ticks = 0;
      store.timer = setInterval(() => {
        ticks += 1;
        const work = every && ticks % every === 0 ? store.compact() : store.flush();
        void work.catch(() => undefined);
      }, opts.flushIntervalMs);
      store.timer.unref();
    }
    return store;
  }

  append(batch: Batch, createdMs?: number): Promise<AppendResult> {
    return this.wal.append(batch, createdMs);
  }

  /** Number of records that are durable but not yet in a Parquet segment. */
  get pendingRows(): number {
    return this.hot.length;
  }

  get walOffset(): number {
    return this.ingestedOffset;
  }

  private ingest(records: LogRecord[], end: number): void {
    for (const r of records) {
      const m = this.miner.mine(r.service, r.body);
      this.hot.push({
        seq: this.nextSeq++,
        tsNs: BigInt(r.tsNs),
        service: r.service,
        severity: r.severity ?? "",
        templateId: m.templateId,
        version: m.version,
        params: JSON.stringify(m.params),
        verbatim: m.templateId === -1 ? r.body : null,
      });
    }
    this.stats.ingested += records.length;
    this.ingestedOffset = end;
  }

  /**
   * Every manifest change (flush, compaction) and every query runs under this one lock, so a
   * compaction never commits a segment list that misses a concurrent flush, and a query never
   * reads files a compaction is about to delete.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Make every durable record queryable. Safe to call concurrently. */
  flush(): Promise<void> {
    return this.exclusive(() => this.flushUnlocked());
  }

  private async flushUnlocked(): Promise<void> {
    if (this.hot.length === 0 && this.manifest.walOffset === this.ingestedOffset) return;
    await this.flushOnce();
  }

  private async flushOnce(): Promise<void> {
    const rows = this.hot;
    const walOffset = this.ingestedOffset;
    this.hot = [];
    const seq = this.manifest.seq + 1;
    const next: Manifest = { ...this.manifest, seq, walOffset, segments: [...this.manifest.segments], rollups: [...this.manifest.rollups] };
    if (rows.length) {
      await this.loadRows(rows);
      const seg = `segments/hot-${pad(seq)}.parquet`;
      const roll = `rollups/hot-${pad(seq)}.parquet`;
      await this.copy(`select * from _rows order by service, ts_ns, seq`, seg);
      await this.copy(ROLLUP_SQL("_rows"), roll);
      next.segments.push(seg);
      next.rollups.push(roll);
      crashPoint("store.afterSegment");
    }
    const tpl = `templates/${pad(seq)}.json`;
    await writeDurable(join(this.dir, tpl), JSON.stringify(this.miner.snapshot()));
    next.templates = tpl;
    await this.commit(next);
    this.stats.flushes += 1;
  }

  /** Merge hot segments into one file per hour, sorted by (service, ts); swap via the manifest. */
  compact(): Promise<void> {
    return this.exclusive(() => this.compactUnlocked());
  }

  private async compactUnlocked(): Promise<void> {
    await this.flushUnlocked();
    const hot = this.manifest.segments.filter((s) => s.includes("/hot-"));
    if (hot.length < 2) return;
    const seq = this.manifest.seq + 1;
    const hours = await this.rows<{ hour: bigint }>(
      `select distinct (ts_ns // 3600000000000) as hour from read_parquet(${list(this.paths(hot))}) order by 1`,
    );
    const cold: string[] = [];
    const rolls: string[] = [];
    for (const { hour } of hours) {
      const seg = `segments/cold-${hour}-${pad(seq)}.parquet`;
      const roll = `rollups/cold-${hour}-${pad(seq)}.parquet`;
      const src = `(select * from read_parquet(${list(this.paths(hot))}) where ts_ns // 3600000000000 = ${hour})`;
      await this.copy(`select * from ${src} order by service, ts_ns, seq`, seg);
      await this.copy(ROLLUP_SQL(src), roll);
      cold.push(seg);
      rolls.push(roll);
      crashPoint("store.midCompaction");
    }
    const keepSeg = this.manifest.segments.filter((s) => !hot.includes(s));
    const hotRolls = this.manifest.rollups.filter((r) => r.includes("/hot-"));
    const keepRoll = this.manifest.rollups.filter((r) => !hotRolls.includes(r));
    await this.commit({ ...this.manifest, seq, segments: [...keepSeg, ...cold], rollups: [...keepRoll, ...rolls] });
  }

  /** Run SQL with `logs`, `rollups` and `templates` views over the committed data. Flushes first. */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    return this.exclusive(async () => {
      await this.flushUnlocked();
      await this.defineViews();
      try {
        return await this.rows<T>(sql);
      } catch (e) {
        throw new SiftError("SIFT-E203", `query failed: ${String(e).split("\n")[0]}`,
          "check the SQL against the views logs(seq, ts_ns, service, severity, template_id, template_version, params, verbatim), rollups(minute, service, template_id, severity, n) and templates(template_id, service, template)");
      }
    });
  }

  /** The original message of a stored row. */
  reconstruct(row: { template_id: number; template_version: number; params: string; verbatim: string | null }): string {
    if (row.template_id === -1) return row.verbatim ?? "";
    return this.miner.reconstruct(row.template_id, row.template_version, JSON.parse(row.params) as string[]);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.wal.close();
    await this.flush();
    this.conn.closeSync();
    this.db.closeSync();
  }

  // ---- internals -------------------------------------------------------------------------

  private async defineViews(): Promise<void> {
    const segs = this.paths(this.manifest.segments);
    const rolls = this.paths(this.manifest.rollups);
    await this.conn.run(
      segs.length
        ? `create or replace view logs as select * from read_parquet(${list(segs)})`
        : `create or replace view logs as select * from (select 0::bigint seq, 0::bigint ts_ns, ''::varchar service, ''::varchar severity, 0::integer template_id, 0::integer template_version, ''::varchar params, null::varchar verbatim) where false`,
    );
    await this.conn.run(
      rolls.length
        ? `create or replace view rollups as select * from read_parquet(${list(rolls)})`
        : `create or replace view rollups as select * from (select 0::bigint minute, ''::varchar service, 0::integer template_id, ''::varchar severity, 0::bigint n) where false`,
    );
    await this.conn.run(`create or replace table templates (template_id integer, service varchar, template varchar)`);
    const app = await this.conn.createAppender("templates");
    for (const t of this.miner.snapshot()) {
      app.appendInteger(t.id);
      app.appendVarchar(t.service);
      app.appendVarchar((t.versions[t.versions.length - 1] ?? []).join(" "));
      app.endRow();
    }
    app.closeSync();
  }

  private async loadRows(rows: Row[]): Promise<void> {
    await this.conn.run(`create or replace temp table _rows (seq bigint, ts_ns bigint, service varchar, severity varchar,
      template_id integer, template_version integer, params varchar, verbatim varchar)`);
    const app = await this.conn.createAppender("_rows");
    for (const r of rows) {
      app.appendBigInt(BigInt(r.seq));
      app.appendBigInt(r.tsNs);
      app.appendVarchar(r.service);
      app.appendVarchar(r.severity);
      app.appendInteger(r.templateId);
      app.appendInteger(r.version);
      app.appendVarchar(r.params);
      if (r.verbatim === null) app.appendNull();
      else app.appendVarchar(r.verbatim);
      app.endRow();
    }
    app.closeSync();
  }

  private async copy(select: string, rel: string): Promise<void> {
    const tmp = join(this.dir, `${rel}.tmp`);
    await this.conn.run(`copy (${select}) to '${tmp}' (format parquet, compression zstd)`);
    await fsyncFile(tmp);
    await rename(tmp, join(this.dir, rel));
  }

  private async commit(next: Manifest): Promise<void> {
    const old = this.manifest;
    await writeDurable(join(this.dir, "manifest.json"), JSON.stringify(next, null, 1));
    crashPoint("store.afterManifest");
    this.manifest = next;
    const live = new Set([...next.segments, ...next.rollups, next.templates]);
    const dead = [...old.segments, ...old.rollups, old.templates].filter((f): f is string => !!f && !live.has(f));
    await Promise.all(dead.map((f) => rm(join(this.dir, f), { force: true })));
  }

  private async removeOrphans(): Promise<number> {
    const live = new Set([...this.manifest.segments, ...this.manifest.rollups, this.manifest.templates]);
    let removed = 0;
    for (const sub of ["segments", "rollups", "templates"]) {
      for (const f of await readdir(join(this.dir, sub))) {
        if (!live.has(`${sub}/${f}`)) {
          await rm(join(this.dir, sub, f), { force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }

  private async maxSeq(): Promise<number> {
    if (!this.manifest.segments.length) return 0;
    const [r] = await this.rows<{ m: bigint | null }>(
      `select max(seq) as m from read_parquet(${list(this.paths(this.manifest.segments))})`,
    );
    return r?.m === null || r?.m === undefined ? 0 : Number(r.m) + 1;
  }

  private paths(rel: string[]): string[] {
    return rel.map((r) => join(this.dir, r));
  }

  private async rows<T>(sql: string): Promise<T[]> {
    const reader = await this.conn.runAndReadAll(sql);
    return reader.getRowObjectsJS() as T[];
  }
}

const ROLLUP_SQL = (src: string) =>
  `select (ts_ns // 60000000000)::bigint as minute, service, template_id, severity, count(*)::bigint as n
   from ${src} group by all order by service, minute`;

function list(paths: string[]): string {
  return `[${paths.map((p) => `'${p.replaceAll("'", "''")}'`).join(", ")}]`;
}

function pad(n: number): string {
  return String(n).padStart(8, "0");
}

async function readManifest(dir: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
    throw new SiftError("SIFT-E202", `manifest at ${join(dir, "manifest.json")} is unreadable: ${String(e)}`,
      "restore the data directory from backup or start with an empty --data directory");
  }
}

async function fsyncFile(path: string): Promise<void> {
  const fh = await open(path, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Write a file so that after this returns, either the old or the new content is on disk, never a mix. */
async function writeDurable(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  await fsyncFile(tmp);
  await rename(tmp, path);
  const dir = await open(join(path, ".."), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
