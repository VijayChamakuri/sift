import type { EvidenceItem } from "../detect/investigate.js";
import type { Signal } from "../detect/watch.js";

export const TASK_QUEUE = "sift-investigations";

export interface InvestigationInput {
  runId: string;
  stableName: string; // service:sensor, one issue per name per run
  signal: Signal;
  gatePass: boolean;
  evidence: EvidenceItem[];
  services: string[];
}

export interface InvestigationOutcome {
  stableName: string;
  decision: "open" | "hold";
  decidedBy: "gate" | "model";
  issueCreated: boolean;
}

export interface IssueRow {
  runId: string;
  stableName: string;
  service: string;
  sensor: string;
  eventAt: number;
  summary: string;
  evidence: EvidenceItem[];
  decidedBy: "gate" | "model";
}
