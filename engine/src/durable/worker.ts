/**
 * Durable investigations: the Temporal worker, and the client side used by `sift watch --durable`.
 */
import { createRequire } from "node:module";

import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

import { SiftError } from "../errors.js";
import * as activities from "./activities.js";
import { TASK_QUEUE, type InvestigationInput, type InvestigationOutcome } from "./types.js";

const ADDRESS = process.env.SIFT_TEMPORAL_ADDRESS ?? "127.0.0.1:7233";

function unreachable(e: unknown): SiftError {
  return new SiftError("SIFT-E202", `Temporal is not reachable at ${ADDRESS}: ${String(e).split("\n")[0]}`,
    "start it with: docker compose -f deploy/docker-compose.yml up -d");
}

export async function runWorker(): Promise<void> {
  await activities.db().query(activities.SCHEMA);
  let connection: NativeConnection;
  try {
    connection = await NativeConnection.connect({ address: ADDRESS });
  } catch (e) {
    throw unreachable(e);
  }
  const require = createRequire(import.meta.url);
  const worker = await Worker.create({
    connection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("./workflows.js"),
    activities,
    maxConcurrentActivityTaskExecutions: 1, // one model call at a time on a laptop
  });
  process.stdout.write(`${JSON.stringify({ worker: "ready", taskQueue: TASK_QUEUE, address: ADDRESS })}\n`);
  await worker.run();
}

export async function startInvestigation(client: Client, input: InvestigationInput): Promise<string> {
  const id = `${input.runId}:${input.stableName}:${input.signal.at}`;
  await client.workflow.start("investigate", { taskQueue: TASK_QUEUE, workflowId: id, args: [input] });
  return id;
}

export async function connectClient(): Promise<Client> {
  try {
    return new Client({ connection: await Connection.connect({ address: ADDRESS }) });
  } catch (e) {
    throw unreachable(e);
  }
}

export async function waitAll(client: Client, ids: string[]): Promise<InvestigationOutcome[]> {
  return Promise.all(ids.map((id) => client.workflow.getHandle(id).result() as Promise<InvestigationOutcome>));
}
