/**
 * Activities: the side-effecting steps of an investigation. Temporal retries them; both are safe to
 * repeat. The model call has no side effects; the issue insert is idempotent on (run_id, stable_name).
 */
import pg from "pg";

import { askModel, llmFromEnv, type LlmVerdict } from "../detect/investigate.js";
import { crashPoint } from "../logstore/crashpoints.js";
import type { InvestigationInput, IssueRow } from "./types.js";

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: process.env.SIFT_PG_URL ?? "postgres://sift:sift-local-only@127.0.0.1:5433/sift", max: 4 });
  return pool;
}

export const SCHEMA = `
create table if not exists issues (
  run_id      text not null,
  stable_name text not null,
  service     text not null,
  sensor      text not null,
  event_at    bigint not null,
  summary     text not null,
  evidence    jsonb not null,
  decided_by  text not null,
  opened_at   timestamptz not null default now(),
  primary key (run_id, stable_name)
)`;

export async function llmVerdict(input: InvestigationInput): Promise<LlmVerdict> {
  crashPoint("activity.llmVerdict");
  const client = llmFromEnv();
  if (!client) {
    return { ok: false, verdict: null, service: null, summary: null, cited: [], failure: "unavailable", latencyMs: 0, inputTokens: 0, outputTokens: 0, raw: "" };
  }
  return askModel(client, input.signal, input.evidence, new Set(input.services));
}

/** Insert the issue once; a retried or replayed activity finds the row and changes nothing. */
export async function openIssue(issue: IssueRow): Promise<boolean> {
  crashPoint("activity.openIssue");
  const res = await db().query(
    `insert into issues (run_id, stable_name, service, sensor, event_at, summary, evidence, decided_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (run_id, stable_name) do nothing`,
    [issue.runId, issue.stableName, issue.service, issue.sensor, issue.eventAt, issue.summary, JSON.stringify(issue.evidence), issue.decidedBy],
  );
  return (res.rowCount ?? 0) > 0;
}
