import { mkdtemp, open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SiftError } from "../src/errors.js";
import { Wal } from "../src/logstore/wal.js";

const rec = (n: number) => ({ tsNs: String(1_700_000_000_000_000_000n + BigInt(n)), service: "svc", body: `seq=${n}` });

async function tmp(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "sift-wal-")), "wal.log");
}

describe("Wal", () => {
  it("acks in order and replays every acked record after reopening", async () => {
    const path = await tmp();
    const wal = await Wal.open(path);
    const acks = await Promise.all(Array.from({ length: 200 }, (_, i) => wal.append({ records: [rec(i)] })));
    expect(acks.map((a) => a.offset)).toEqual([...acks.map((a) => a.offset)].sort((a, b) => a - b));
    await wal.close();
    const again = await Wal.open(path);
    const seen: string[] = [];
    for await (const f of again.scan(0)) seen.push(...f.records.map((r) => r.body));
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => `seq=${i}`));
    await again.close();
  });

  it("drops a torn tail on open and keeps everything before it", async () => {
    const path = await tmp();
    const wal = await Wal.open(path);
    await wal.append({ records: [rec(1)] });
    const second = await wal.append({ records: [rec(2)] });
    await wal.close();
    const fh = await open(path, "r+");
    await fh.truncate(second.offset - 5); // simulate a frame cut short by a crash
    await fh.close();
    const reopened = await Wal.open(path);
    expect(reopened.recovery.frames).toBe(1);
    expect(reopened.recovery.truncatedBytes).toBeGreaterThan(0);
    expect((await stat(path)).size).toBe(reopened.end);
    await reopened.close();
  });

  it("writes a batch with an id once, even when retried concurrently or after a restart", async () => {
    const path = await tmp();
    const wal = await Wal.open(path);
    const [a, b] = await Promise.all([
      wal.append({ batchId: "b-1", records: [rec(1)] }),
      wal.append({ batchId: "b-1", records: [rec(1)] }),
    ]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    await wal.close();
    const reopened = await Wal.open(path);
    const c = await reopened.append({ batchId: "b-1", records: [rec(1)] });
    expect(c.duplicate).toBe(true);
    let frames = 0;
    for await (const _ of reopened.scan(0)) frames += 1;
    expect(frames).toBe(1);
    await reopened.close();
  });

  it("rejects a retry first sent before the dedup horizon with SIFT-E105", async () => {
    let now = 1_000_000;
    const wal = await Wal.open(await tmp(), { horizonMs: 1000, now: () => now });
    now += 5000;
    await expect(wal.append({ batchId: "old", records: [rec(1)] }, 1_000_000)).rejects.toMatchObject({ code: "SIFT-E105" });
    await wal.close();
  });

  it("applies backpressure with a retryable SIFT-E103 when too much is queued", async () => {
    const wal = await Wal.open(await tmp(), { maxPendingBytes: 200 });
    const big = { records: [{ ...rec(1), body: "x".repeat(500) }] };
    const err = await wal.append(big).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiftError);
    expect((err as SiftError).code).toBe("SIFT-E103");
    expect((err as SiftError).retryable).toBe(true);
    await wal.close();
  });
});
