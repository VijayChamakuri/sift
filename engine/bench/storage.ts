/**
 * What Sift's store costs on disk for one Loghub-2.0 system, and proof that it is lossless.
 *
 *   1. stream the raw log file line by line (split on "\n" only, so "\r" and trailing spaces survive)
 *   2. append every line to a fresh store (service = the system name, timestamps = line order),
 *      flushing to Parquet every 500,000 lines, then compact
 *   3. measure bytes on disk: Parquet segments, rollups, template registry and manifest (the store),
 *      and the write-ahead log separately (Sift does not yet trim the WAL after a commit)
 *   4. read every line back in order, rebuild it from template + parameters, and compare the SHA-256
 *      of the rebuilt stream with the SHA-256 of the input stream
 *   5. write each line's template id (Int32, line order) so grouping accuracy can be scored in Python
 *
 * Usage: tsx bench/storage.ts --log <X_full.log> --name X --work <scratch dir> --out <json> --ids <bin>
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { LogStore } from "../src/logstore/store.js";
import type { LogRecord } from "../src/types.js";

const { values } = parseArgs({
  options: {
    log: { type: "string" },
    name: { type: "string" },
    work: { type: "string" },
    out: { type: "string" },
    ids: { type: "string" },
  },
});
const BATCH = 20_000;
const FLUSH_EVERY = 500_000;
const T0 = 1_700_000_000_000_000_000n;

async function* lines(path: string): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 22 })) {
    const parts = (rest + (chunk as string)).split("\n");
    rest = parts.pop() ?? "";
    yield* parts;
  }
  if (rest.length) yield rest; // a last line without a newline still counts
}

async function bytesIn(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? await bytesIn(p) : (await stat(p)).size;
  }
  return total;
}

const dir = join(values.work!, `store-${values.name}`);
await rm(dir, { recursive: true, force: true });
const store = await LogStore.open(dir, { memoryLimit: "1GB", threads: 2 });

const inputHash = createHash("sha256");
let n = 0;
let batch: LogRecord[] = [];
const t0 = performance.now();
for await (const line of lines(values.log!)) {
  inputHash.update(line).update("\n");
  batch.push({ tsNs: String(T0 + BigInt(n) * 1_000_000n), service: values.name!, body: line });
  n += 1;
  if (batch.length === BATCH) {
    await store.append({ records: batch });
    batch = [];
  }
  if (n % FLUSH_EVERY === 0) await store.flush();
}
if (batch.length) await store.append({ records: batch });
await store.flush();
await store.compact();
const ingestSeconds = (performance.now() - t0) / 1000;

const sizes = {
  segments: await bytesIn(join(dir, "segments")),
  rollups: await bytesIn(join(dir, "rollups")),
  templates: await bytesIn(join(dir, "templates")),
  manifest: (await stat(join(dir, "manifest.json")).catch(() => ({ size: 0 }))).size,
  wal: (await stat(join(dir, "wal.log"))).size,
};

// read back in order and rebuild every line
type Row = { seq: bigint; template_id: number; template_version: number; params: string; verbatim: string | null };
const outputHash = createHash("sha256");
const ids = new Int32Array(n);
let read = 0;
const [{ lo, hi }] = await store.query<{ lo: bigint; hi: bigint }>("select min(seq) lo, max(seq) hi from logs");
const STEP = 200_000n;
for (let a = BigInt(lo); a <= BigInt(hi); a += STEP) {
  const rows = await store.query<Row>(
    `select seq, template_id, template_version, params, verbatim from logs where seq >= ${a} and seq < ${a + STEP} order by seq`,
  );
  for (const r of rows) {
    outputHash.update(store.reconstruct(r)).update("\n");
    ids[read] = r.template_id;
    read += 1;
  }
}
const templates = new Set(ids).size;
await store.close();

const out = {
  name: values.name,
  lines: n,
  linesReadBack: read,
  rawBytes: (await stat(values.log!)).size,
  storeBytes: sizes.segments + sizes.rollups + sizes.templates + sizes.manifest,
  sizes,
  lossless: read === n && inputHash.digest("hex") === outputHash.digest("hex"),
  templates,
  verbatimLines: ids.filter((x) => x === -1).length,
  ingestSeconds: Math.round(ingestSeconds * 10) / 10,
};
await mkdir(dirname(values.out!), { recursive: true });
await writeFile(values.out!, `${JSON.stringify(out, null, 2)}\n`);
await writeFile(values.ids!, Buffer.from(ids.buffer));
await rm(dir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(out.lossless ? 0 : 1);
