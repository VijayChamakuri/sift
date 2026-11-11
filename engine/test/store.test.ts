import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LogStore } from "../src/logstore/store.js";

const T0 = 1_705_354_566n * 1_000_000_000n;
const rec = (n: number, service = n % 3 === 0 ? "cart" : "frontend") => ({
  tsNs: String(T0 + BigInt(n) * 1_000_000_000n),
  service,
  body: n % 7 === 0 ? `error: rpc to cart failed after ${n}ms` : `request ${n} complete in ${n % 50}ms`,
});

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sift-store-"));
}

type Row = { seq: bigint; service: string; template_id: number; template_version: number; params: string; verbatim: string | null };

async function lines(store: LogStore): Promise<string[]> {
  const rows = await store.query<Row>("select * from logs order by seq");
  return rows.map((r) => store.reconstruct(r));
}

describe("LogStore", () => {
  it("stores every line losslessly and reconstructs it from template + params", async () => {
    const d = await dir();
    const store = await LogStore.open(d);
    const input = Array.from({ length: 500 }, (_, i) => rec(i));
    for (let i = 0; i < input.length; i += 50) await store.append({ records: input.slice(i, i + 50) });
    expect(await lines(store)).toEqual(input.map((r) => r.body));
    await store.close();
  });

  it("rebuilds the same state after a restart, with or without a flush in between", async () => {
    const d = await dir();
    const a = await LogStore.open(d);
    await a.append({ records: Array.from({ length: 100 }, (_, i) => rec(i)) });
    await a.flush();
    await a.append({ records: Array.from({ length: 100 }, (_, i) => rec(100 + i)) }); // durable, not flushed
    const before = await lines(a);
    // simulate a crash: drop the object without close(), reopen the same directory
    const b = await LogStore.open(d);
    expect(await lines(b)).toEqual(before);
    await b.close();
  });

  it("deletes files the manifest does not name (leftovers of a crash before commit)", async () => {
    const d = await dir();
    const a = await LogStore.open(d);
    await a.append({ records: [rec(1)] });
    await a.close();
    await writeFile(join(d, "segments", "hot-99999999.parquet"), "garbage");
    const b = await LogStore.open(d);
    expect(b.stats.removedOrphans).toBe(1);
    expect(await readdir(join(d, "segments"))).not.toContain("hot-99999999.parquet");
    await b.close();
  });

  it("returns the same rows before and after compaction, and rollups match raw counts", async () => {
    const d = await dir();
    const s = await LogStore.open(d);
    for (let k = 0; k < 5; k++) {
      await s.append({ records: Array.from({ length: 40 }, (_, i) => rec(k * 40 + i)) });
      await s.flush();
    }
    const before = await lines(s);
    await s.compact();
    expect(await lines(s)).toEqual(before);
    const [raw] = await s.query<{ n: bigint }>("select count(*) n from logs");
    const [roll] = await s.query<{ n: bigint }>("select sum(n)::bigint n from rollups");
    expect(roll?.n).toBe(raw?.n);
    await s.close();
  });
});
