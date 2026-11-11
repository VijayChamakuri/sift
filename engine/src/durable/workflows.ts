/**
 * Temporal workflow for one investigation. Workflow code must be deterministic, so it only decides
 * and sequences; the model call and the database write are activities that Temporal retries and
 * whose results it records, so a worker that dies mid-investigation resumes where it stopped.
 *
 *   investigate(input)
 *     gate held?  -> done (no model call, no issue)
 *     llmVerdict  (activity: retried up to 3 times, 90 s per attempt)
 *     decision    model's answer if usable, otherwise the gate's (open)
 *     openIssue   (activity: idempotent insert keyed on run id + stable name)
 */
import { proxyActivities } from "@temporalio/workflow";

import type * as activities from "./activities.js";
import type { InvestigationInput, InvestigationOutcome } from "./types.js";

const { llmVerdict } = proxyActivities<typeof activities>({
  startToCloseTimeout: "90 seconds",
  retry: { maximumAttempts: 3, initialInterval: "1 second" },
});
const { openIssue } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 10, initialInterval: "1 second" },
});

export async function investigate(input: InvestigationInput): Promise<InvestigationOutcome> {
  if (!input.gatePass) return { stableName: input.stableName, decision: "hold", decidedBy: "gate", issueCreated: false };
  const verdict = await llmVerdict(input);
  const usable = verdict.ok && verdict.verdict !== null;
  const decision = usable ? verdict.verdict! : "open";
  if (decision === "hold") return { stableName: input.stableName, decision, decidedBy: "model", issueCreated: false };
  const created = await openIssue({
    runId: input.runId,
    stableName: input.stableName,
    service: usable && verdict.service ? verdict.service : input.signal.service,
    sensor: input.signal.sensor,
    eventAt: input.signal.at,
    summary: verdict.summary ?? input.signal.detail,
    evidence: input.evidence,
    decidedBy: usable ? "model" : "gate",
  });
  return { stableName: input.stableName, decision, decidedBy: usable ? "model" : "gate", issueCreated: created };
}
