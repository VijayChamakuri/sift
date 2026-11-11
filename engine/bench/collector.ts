/**
 * A stock OpenTelemetry Collector ships logs to Sift unmodified.
 *
 *   1. write N real log lines (the bundled demo incident) to a file
 *   2. start `sift serve` on 127.0.0.1
 *   3. run otel/opentelemetry-collector-contrib (pinned) in Docker with a plain config: filelog
 *      receiver -> resource processor (service.name) -> batch -> otlphttp exporter, default settings
 *      (protobuf, gzip, retries on), pointed at Sift through the Docker host gateway
 *   4. wait until Sift holds N records, then check every line arrived exactly once and unchanged
 *
 * Usage: tsx bench/collector.ts --out ../results/infra/collector.json
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { readLogFile } from "../src/surfaces/replay.js";

const IMAGE = "otel/opentelemetry-collector-contrib:0.165.0";
const PORT = 4320;
const CLI = fileURLToPath(new URL("../src/surfaces/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../../fixtures/demo/logs.parquet", import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string", default: "../results/infra/collector.json" } } });

const CONFIG = `receivers:
  filelog:
    include: [/logs/app.log]
    start_at: beginning
processors:
  resource:
    attributes:
      - { key: service.name, value: collector-demo, action: upsert }
  batch: {}
exporters:
  otlphttp:
    endpoint: http://host.docker.internal:${PORT}
service:
  pipelines:
    logs:
      receivers: [filelog]
      processors: [resource, batch]
      exporters: [otlphttp]
`;

// under the repo, not /tmp: Docker on macOS (Colima) only shares the home folder with containers
const SCRATCH = fileURLToPath(new URL("../../.sift/", import.meta.url));
await mkdir(SCRATCH, { recursive: true });
const dir = await mkdtemp(join(SCRATCH, "collector-"));
const lines = (await readLogFile(FIXTURE)).map((r) => `${r.service} ${r.body}`.replaceAll("\n", " "));
await mkdir(join(dir, "logs"));
await writeFile(join(dir, "logs", "app.log"), lines.join("\n") + "\n");
await writeFile(join(dir, "config.yaml"), CONFIG);

// one node process (tsx as a loader), so killing it stops the server
const server = spawn(process.execPath, ["--import", "tsx", CLI, "serve", "--data", join(dir, "data"), "--port", String(PORT), "--json"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((resolve) => server.stdout!.on("data", (d: Buffer) => d.toString().includes("listening") && resolve()));

setTimeout(() => {
  process.stderr.write("collector test timed out after 240 s\n");
  server.kill("SIGKILL");
  process.exit(2);
}, 240_000).unref();
const started = Date.now();
const collector = spawn("docker", ["run", "--rm", "--name", "sift-collector-test", "--add-host", "host.docker.internal:host-gateway",
  "-v", `${join(dir, "config.yaml")}:/etc/otelcol-contrib/config.yaml:ro`, "-v", `${join(dir, "logs")}:/logs:ro`, IMAGE], { stdio: ["ignore", "ignore", "pipe"] });
let collectorLog = "";
collector.stderr!.on("data", (d: Buffer) => (collectorLog += d.toString()));

const query = async (sql: string, reconstruct = false) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql, reconstruct }) });
  return ((await res.json()) as { rows: Record<string, unknown>[] }).rows;
};
let received = 0;
while (Date.now() - started < 180_000) {
  received = Number((await query("select count(*)::integer n from logs"))[0]?.n ?? 0);
  if (received >= lines.length) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await new Promise((r) => setTimeout(r, 3000)); // let any late duplicate arrive before counting
const rows = await query("select service, template_id, template_version, params, verbatim from logs", true);
spawn("docker", ["stop", "sift-collector-test"]).on("exit", () => undefined);
server.kill("SIGTERM");

// the filelog receiver trims trailing whitespace by default (preserve_trailing_whitespaces: false),
// so the stock Collector sends each line right-trimmed; Sift must store exactly that
const sent = new Map<string, number>();
for (const l of lines) sent.set(l.trimEnd(), (sent.get(l.trimEnd()) ?? 0) + 1);
const trimmedByCollector = lines.filter((l) => l !== l.trimEnd()).length;
const got = new Map<string, number>();
for (const r of rows) got.set(String(r.line), (got.get(String(r.line)) ?? 0) + 1);
let missing = 0;
let extra = 0;
for (const [l, n] of sent) {
  const g = got.get(l) ?? 0;
  if (g < n) missing += n - g;
  if (g > n) extra += g - n;
}
const out = {
  ok: missing === 0 && extra === 0 && rows.every((r) => r.service === "collector-demo"),
  collector: IMAGE,
  exporter: "otlphttp with default settings (protobuf, gzip compression, retries on)",
  linesWritten: lines.length,
  recordsReceived: rows.length,
  missing,
  duplicated: extra,
  linesTrimmedByCollector: trimmedByCollector,
  note: "filelog trims trailing whitespace by default; lines are compared to what the Collector sends",
  serviceName: [...new Set(rows.map((r) => r.service))],
  seconds: Math.round((Date.now() - started) / 1000),
  collectorErrors: collectorLog.split("\n").filter((l) => /error/i.test(l)).slice(0, 5),
  measuredAt: new Date().toISOString(),
};
await mkdir(dirname(values.out!), { recursive: true });
await writeFile(values.out!, `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(out.ok ? 0 : 1);
