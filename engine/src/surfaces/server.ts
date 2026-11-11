/**
 * OTLP/HTTP intake (`POST /v1/logs`) and the local query API, over one LogStore.
 * Binds 127.0.0.1 by default: there is no authentication, so it must not face a network.
 */
import { gunzipSync } from "node:zlib";

import Fastify, { type FastifyInstance } from "fastify";

import { SiftError } from "../errors.js";
import type { LogStore } from "../logstore/store.js";
import { rank } from "../detect/rank.js";
import { parseRequest } from "./otlp.js";

/** A gzip bomb must not inflate past this (the same order as the 16 MiB body limit, times 4). */
const MAX_INFLATED = 64 * 1024 * 1024;

export interface ServerOptions {
  bodyLimit?: number;
}

export function buildServer(store: LogStore, opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ bodyLimit: opts.bodyLimit ?? 16 * 1024 * 1024, logger: false });
  for (const ct of ["application/x-protobuf", "application/protobuf", "application/json"]) {
    app.addContentTypeParser(ct, { parseAs: "buffer" }, (req, body, done) => {
      // OpenTelemetry Collector exporters gzip OTLP/HTTP bodies by default
      const encoding = String(req.headers["content-encoding"] ?? "identity").toLowerCase();
      if (encoding === "identity") return done(null, body);
      if (encoding !== "gzip") {
        return done(new SiftError("SIFT-E101", `unsupported content-encoding ${encoding}`, "send identity or gzip", { httpStatus: 415 }), undefined);
      }
      try {
        const raw = gunzipSync(body as Buffer, { maxOutputLength: MAX_INFLATED });
        done(null, raw);
      } catch (e) {
        const tooBig = String(e).includes("maxOutputLength") || String(e).includes("Cannot create a Buffer");
        done(tooBig
          ? new SiftError("SIFT-E102", `gzip body inflates beyond ${MAX_INFLATED} bytes`, "send smaller batches", { httpStatus: 413 })
          : new SiftError("SIFT-E101", `gzip body could not be decompressed: ${String(e).split("\n")[0]}`, "check the sender's compression setting", { httpStatus: 400 }), undefined);
      }
    });
  }

  app.setErrorHandler((err, req, reply) => {
    const e = err instanceof SiftError
      ? err
      : (err as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE"
        ? new SiftError("SIFT-E102", `request body exceeds ${app.initialConfig.bodyLimit} bytes`, "send smaller batches", { httpStatus: 413 })
        : (err as { code?: string }).code === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
          ? new SiftError("SIFT-E101", `unsupported content-type ${req.headers["content-type"] ?? "(none)"}`,
            "use application/x-protobuf or application/json", { httpStatus: 415 })
          : new SiftError("SIFT-E203", String((err as Error).message ?? err), "see the server log", { httpStatus: 500 });
    if (e.httpStatus === 429) reply.header("retry-after", "1");
    reply.status(e.httpStatus).type("application/problem+json").send(e.problem(req.url));
  });

  app.post("/v1/logs", async (req, reply) => {
    const records = parseRequest(req.body as Buffer, String(req.headers["content-type"] ?? ""));
    const batchId = req.headers["x-sift-batch-id"];
    const created = Number(req.headers["x-sift-batch-created"] ?? NaN);
    const res = await store.append(
      { ...(typeof batchId === "string" ? { batchId } : {}), records },
      Number.isFinite(created) ? created : undefined,
    );
    // OTLP/HTTP success body: ExportLogsServiceResponse with no partial success
    reply.status(200).type(String(req.headers["content-type"] ?? "").includes("json") ? "application/json" : "application/x-protobuf");
    return String(req.headers["content-type"] ?? "").includes("json") ? { duplicate: res.duplicate } : Buffer.alloc(0);
  });

  app.post("/query", async (req) => {
    // JSON bodies arrive as raw bytes (OTLP/JSON shares the content type), so parse here
    let body: { sql?: string; reconstruct?: boolean };
    try {
      body = Buffer.isBuffer(req.body) ? (JSON.parse(req.body.toString("utf8")) as typeof body) : (req.body as typeof body);
    } catch {
      throw new SiftError("SIFT-E401", "query body is not valid JSON", 'POST {"sql": "select ..."} to /query', { httpStatus: 400 });
    }
    const { sql, reconstruct } = body ?? {};
    if (!sql) throw new SiftError("SIFT-E401", "query body has no sql field", 'POST {"sql": "select ..."} to /query', { httpStatus: 400 });
    const rows = await store.query<Record<string, unknown>>(sql);
    if (!reconstruct) return { rows };
    // rows must carry template_id, template_version, params, verbatim
    return {
      rows: rows.map((r) => ({
        ...r,
        line: store.reconstruct(r as { template_id: number; template_version: number; params: string; verbatim: string | null }),
      })),
    };
  });

  app.get("/rank", async (req) => {
    const at = Number((req.query as { at?: string }).at);
    if (!Number.isFinite(at)) throw new SiftError("SIFT-E401", "rank needs ?at=<unix seconds>", "GET /rank?at=1705354566", { httpStatus: 400 });
    return rank(store, at);
  });

  app.get("/healthz", async () => ({ ok: true, walOffset: store.walOffset, pendingRows: store.pendingRows }));
  return app;
}
