/**
 * Logs-only root-cause ranking around an alarm time T.
 *
 * Per service, three kinds of evidence, each from template counts in [T - window, T) vs
 * [T, T + window):
 *
 *   novelty  templates whose first line ever arrives at or after T (mined online, so "first ever"
 *            is well defined); weighted up when the template reads as an error.
 *   surge    existing error templates that occur more often after T than before.
 *   shift    the service's log volume departs from the system-wide trend: log(1 + |z|), z the
 *            Poisson deviation of the after-count from before-count x trend. Catches silence and
 *            floods, ignores a system-wide traffic drop, and does not inflate tiny services.
 *
 * score = wNovelty * novelty + wSurge * surge + wShift * shift. Services with no evidence are
 * not ranked: they tie at the bottom, and the scorer handles ties the same for every method.
 * All weights and the window live in the config, which is tuned on Dev only and frozen.
 */
import type { LogStore } from "../logstore/store.js";

export interface RankConfig {
  windowSeconds: number;
  wNovelty: number;
  wSurge: number;
  wShift: number;
  errorWeight: number;
  minCount: number;
}

export const DEFAULT_RANK_CONFIG: RankConfig = {
  windowSeconds: 300,
  wNovelty: 1,
  wSurge: 1,
  wShift: 1,
  errorWeight: 2,
  minCount: 1,
};

const ERROR_WORDS =
  /\b(error|errors|err|exception|exceptions|fail|fails|failed|failure|fatal|panic|traceback|refused|unavailable|timeout|timed out|deadline|denied|invalid|unable|cannot|could not|severe|warn|warning|crash|abort|aborted|reset|broken|unreachable|unhealthy|5\d\d)\b/i;

export function isErrorText(text: string, severity = ""): boolean {
  return /^(error|fatal|critical|warn)/i.test(severity) || ERROR_WORDS.test(text);
}

export interface Evidence {
  kind: "novelty" | "surge" | "shift";
  templateId: number | null;
  template: string;
  before: number;
  after: number;
  example: string | null;
}

export interface RankedService {
  service: string;
  score: number;
  novelty: number;
  surge: number;
  shift: number;
  evidence: Evidence[];
}

export interface RankResult {
  at: number;
  ranking: RankedService[];
  servicesSeen: number;
  linesInWindow: number;
}

interface TemplateCounts {
  service: string;
  template_id: number;
  before: number;
  after: number;
  first_ts: bigint;
  template: string | null;
  severity: string;
}

export async function rank(store: LogStore, atSeconds: number, cfg: RankConfig = DEFAULT_RANK_CONFIG): Promise<RankResult> {
  const t = BigInt(atSeconds) * 1_000_000_000n;
  const w = BigInt(cfg.windowSeconds) * 1_000_000_000n;
  const rows = await store.query<TemplateCounts>(`
    with first_seen as (
      select service, template_id, min(ts_ns) first_ts from logs group by all
    ), win as (
      select service, template_id, any_value(severity) severity,
        count(*) filter (where ts_ns < ${t})::integer before,
        count(*) filter (where ts_ns >= ${t})::integer after
      from logs where ts_ns >= ${t - w} and ts_ns < ${t + w} group by all
    )
    select win.*, first_seen.first_ts, templates.template
    from win join first_seen using (service, template_id)
    left join templates using (template_id, service)
    order by service, template_id`);

  const perService = new Map<string, TemplateCounts[]>();
  for (const r of rows) {
    const list = perService.get(r.service);
    if (list) list.push(r);
    else perService.set(r.service, [r]);
  }

  const volumes = [...perService].map(([service, ts]) => ({
    service,
    before: ts.reduce((s, x) => s + x.before, 0),
    after: ts.reduce((s, x) => s + x.after, 0),
  }));
  // system-wide trend: if every service's volume moves together (a traffic drop), that is not evidence
  const trend = (volumes.reduce((s, v) => s + v.after, 0) + 1) / (volumes.reduce((s, v) => s + v.before, 0) + 1);

  const ranking: RankedService[] = [];
  for (const [service, ts] of perService) {
    let novelty = 0;
    let surge = 0;
    const evidence: Evidence[] = [];
    for (const r of ts) {
      const text = r.template ?? "";
      const err = isErrorText(text, r.severity);
      if (r.after >= cfg.minCount && r.first_ts >= t) {
        const v = (err ? cfg.errorWeight : 1) * Math.log1p(r.after);
        novelty += v;
        evidence.push({ kind: "novelty", templateId: r.template_id, template: text, before: r.before, after: r.after, example: null });
      } else if (err && r.after > r.before) {
        surge += Math.log((r.after + 1) / (r.before + 1));
        evidence.push({ kind: "surge", templateId: r.template_id, template: text, before: r.before, after: r.after, example: null });
      }
    }
    const vol = volumes.find((v) => v.service === service)!;
    // Poisson deviation from the system trend: a 5 → 5 change in a quiet service is not dramatic
    const expected = vol.before * trend;
    const z = (vol.after - expected) / Math.sqrt(expected + 1);
    const shift = Math.log1p(Math.abs(z));
    if (Math.abs(z) > 3) evidence.push({ kind: "shift", templateId: null, template: "(all lines)", before: vol.before, after: vol.after, example: null });
    const score = cfg.wNovelty * novelty + cfg.wSurge * surge + cfg.wShift * shift;
    if (score > 0) {
      evidence.sort((a, b) => b.after - b.before - (a.after - a.before));
      ranking.push({ service, score, novelty, surge, shift, evidence: evidence.slice(0, 3) });
    }
  }
  ranking.sort((a, b) => b.score - a.score || a.service.localeCompare(b.service));

  // one real example line per evidence item for the top services
  for (const r of ranking.slice(0, 3)) {
    for (const e of r.evidence) {
      if (e.templateId === null) continue;
      const [row] = await store.query<{ template_id: number; template_version: number; params: string; verbatim: string | null }>(
        `select template_id, template_version, params, verbatim from logs
         where service = '${r.service.replaceAll("'", "''")}' and template_id = ${e.templateId} and ts_ns >= ${t}
         order by ts_ns, seq limit 1`);
      if (row) e.example = store.reconstruct(row);
    }
  }
  return {
    at: atSeconds,
    ranking,
    servicesSeen: perService.size,
    linesInWindow: rows.reduce((s, r) => s + r.before + r.after, 0),
  };
}
