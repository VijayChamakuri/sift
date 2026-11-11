import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LogStore } from "../src/logstore/store.js";
import { encodeRequest } from "../src/surfaces/otlp.js";
import { buildServer } from "../src/surfaces/server.js";

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function server() {
  const store = await LogStore.open(await mkdtemp(join(tmpdir(), "sift-srv-")));
  const app = buildServer(store);
  close = async () => {
    await app.close();
    await store.close();
  };
  return app;
}

const rec = (n: number) => ({ tsNs: String(1_705_354_566_000_000_000n + BigInt(n)), service: "frontend", body: `request ${n} ok` });

describe("OTLP/HTTP intake and query API", () => {
  it("accepts protobuf, deduplicates a retried batch id, and answers queries with reconstructed lines", async () => {
    const app = await server();
    const payload = Buffer.from(encodeRequest([rec(1), rec(2)]));
    const headers = { "content-type": "application/x-protobuf", "x-sift-batch-id": "b1", "x-sift-batch-created": String(Date.now()) };
    expect((await app.inject({ method: "POST", url: "/v1/logs", headers, payload })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/logs", headers, payload })).statusCode).toBe(200);
    const q = await app.inject({
      method: "POST",
      url: "/query",
      payload: { sql: "select template_id, template_version, params, verbatim from logs order by seq", reconstruct: true },
    });
    expect(q.statusCode).toBe(200);
    expect((q.json() as { rows: { line: string }[] }).rows.map((r) => r.line)).toEqual(["request 1 ok", "request 2 ok"]);
  });

  it("accepts OTLP/JSON", async () => {
    const app = await server();
    const body = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "cart" } }] },
        scopeLogs: [{ logRecords: [{ timeUnixNano: "1705354566000000000", severityText: "ERROR", body: { stringValue: "boom" } }] }],
      }],
    };
    expect((await app.inject({ method: "POST", url: "/v1/logs", payload: body })).statusCode).toBe(200);
    const q = await app.inject({ method: "POST", url: "/query", payload: { sql: "select service, severity from logs" } });
    expect((q.json() as { rows: unknown[] }).rows).toEqual([{ service: "cart", severity: "ERROR" }]);
  });

  it("rejects a malformed body with an RFC 9457 problem and a stable code", async () => {
    const app = await server();
    const res = await app.inject({
      method: "POST",
      url: "/v1/logs",
      headers: { "content-type": "application/x-protobuf" },
      payload: Buffer.from([0xff, 0xff, 0xff, 0x01]),
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({ title: "SIFT-E101", status: 400 });
    expect((res.json() as { fix: string }).fix).toMatch(/x-protobuf/);
  });

  it("returns a usage problem for a query without sql", async () => {
    const app = await server();
    const res = await app.inject({ method: "POST", url: "/query", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ title: "SIFT-E401" });
  });
});
