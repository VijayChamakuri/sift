/**
 * OTLP/HTTP logs: parse `ExportLogsServiceRequest` (protobuf or JSON) into domain records at the
 * edge, and encode records for Sift's own sender. Nothing outside `surfaces` sees OTLP types.
 */
import { fileURLToPath } from "node:url";

import protobuf from "protobufjs";

import { SiftError } from "../errors.js";
import type { LogRecord } from "../types.js";

const PROTO_ROOT = fileURLToPath(new URL("../../proto/", import.meta.url));

let requestType: protobuf.Type | null = null;

function type(): protobuf.Type {
  if (!requestType) {
    const root = new protobuf.Root();
    root.resolvePath = (_origin, target) => PROTO_ROOT + target;
    root.loadSync("opentelemetry/proto/collector/logs/v1/logs_service.proto", { keepCase: false });
    requestType = root.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest");
  }
  return requestType;
}

interface AnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
  bytesValue?: string;
}
interface KeyValue {
  key: string;
  value?: AnyValue;
}
interface OtlpLogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  severityText?: string;
  body?: AnyValue;
}
interface OtlpRequest {
  resourceLogs?: {
    resource?: { attributes?: KeyValue[] };
    scopeLogs?: { logRecords?: OtlpLogRecord[] }[];
  }[];
}

function text(v: AnyValue | undefined): string {
  if (!v) return "";
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return String(v.intValue);
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  return JSON.stringify(v);
}

function flatten(req: OtlpRequest): LogRecord[] {
  const out: LogRecord[] = [];
  for (const rl of req.resourceLogs ?? []) {
    const attr = rl.resource?.attributes?.find((a) => a.key === "service.name");
    const service = text(attr?.value) || "unknown_service";
    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const ts = String(lr.timeUnixNano ?? "0") !== "0" ? lr.timeUnixNano : lr.observedTimeUnixNano;
        out.push({ tsNs: String(ts ?? "0"), service, body: text(lr.body), ...(lr.severityText ? { severity: lr.severityText } : {}) });
      }
    }
  }
  return out;
}

export function parseRequest(body: Buffer, contentType: string): LogRecord[] {
  try {
    if (contentType.includes("json")) return flatten(JSON.parse(body.toString("utf8")) as OtlpRequest);
    const msg = type().decode(body);
    return flatten(type().toObject(msg, { longs: String, bytes: String, defaults: false }) as OtlpRequest);
  } catch (e) {
    throw new SiftError(
      "SIFT-E101",
      `request body is not a valid OTLP ExportLogsServiceRequest (${contentType || "no content-type"}): ${String(e).split("\n")[0]}`,
      "send OTLP/HTTP with content-type application/x-protobuf or application/json to /v1/logs",
      { httpStatus: 400 },
    );
  }
}

/** Encode records as one protobuf ExportLogsServiceRequest, one ResourceLogs per service. */
export function encodeRequest(records: LogRecord[]): Uint8Array {
  const byService = new Map<string, LogRecord[]>();
  for (const r of records) {
    const list = byService.get(r.service);
    if (list) list.push(r);
    else byService.set(r.service, [r]);
  }
  const payload = {
    resourceLogs: [...byService].map(([service, rs]) => ({
      resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
      scopeLogs: [{
        logRecords: rs.map((r) => ({
          timeUnixNano: r.tsNs,
          body: { stringValue: r.body },
          ...(r.severity ? { severityText: r.severity } : {}),
        })),
      }],
    })),
  };
  const t = type();
  return t.encode(t.fromObject(payload)).finish();
}
