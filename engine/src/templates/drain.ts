/**
 * Online template mining (Drain: He et al., ICWS 2017) with a lossless, versioned registry.
 *
 * Tokens are the message split on single spaces, so `tokens.join(" ")` is the original message
 * byte for byte (empty tokens keep runs of spaces). Tokens that look like values (numbers, hex,
 * UUIDs, IPs) are masked for matching only. When a cluster's template generalises, it gets a
 * new version and older rows keep pointing at the version they were mined under, so every row
 * reconstructs exactly: fill the version's wildcards with the row's parameters.
 *
 * Mining is online and per service: a line is matched only against templates seen earlier in
 * the same service, so nothing is learned from lines that have not arrived yet.
 */

export const WILDCARD = "<*>";

const MASKS: RegExp[] = [
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
  /^0x[0-9a-fA-F]+$/,
  /^[0-9a-fA-F]{16,}$/,
  /^[-+]?\d+(\.\d+)?$/,
  /^[^A-Za-z]*\d[^A-Za-z]*$/, // tokens with digits and no letters: times, dates, ids like 12:03:44 or 2024-01-15
  /^(?=(?:[^0-9]*[0-9]){2})(?=.*[A-Za-z])[A-Za-z0-9_:.-]{6,}$/, // identifiers: >= 6 chars, letters and >= 2 digits (2ZYFJ3GM2N, 34:C)
];

/** Punctuation that wraps values in lists and quotes: ['2ZYFJ3GM2N', or "id=7". */
const WRAP = /^[[\](){}'",;]+|[[\](){}'",;]+$/g;

export function isValueToken(token: string): boolean {
  const core = token.replace(WRAP, "");
  return core.length > 0 && MASKS.some((m) => m.test(core));
}

export interface MinerOptions {
  depth?: number; // prefix-tree depth, Drain default 4
  similarity?: number; // match threshold, Drain3 default 0.4
  maxChildren?: number;
  maxClustersPerService?: number;
  maxTokens?: number;
}

export interface Mined {
  templateId: number; // -1: stored verbatim (over the cap or too long)
  version: number;
  params: string[];
  isNew: boolean; // first line of a new template
}

interface Cluster {
  id: number;
  service: string;
  tokens: string[]; // current version
  versions: string[][]; // all versions, index = version
  count: number;
}

interface Node {
  children: Map<string, Node>;
  clusters: Cluster[];
}

export interface TemplateInfo {
  id: number;
  service: string;
  versions: string[][];
  count: number;
}

export class TemplateMiner {
  private readonly roots = new Map<string, Node>(); // key: service
  private readonly byId: Cluster[] = [];
  private readonly perService = new Map<string, number>();
  readonly verbatimByService = new Map<string, number>();
  private readonly depth: number;
  private readonly sim: number;
  private readonly maxChildren: number;
  private readonly maxClusters: number;
  private readonly maxTokens: number;

  constructor(opts: MinerOptions = {}) {
    this.depth = opts.depth ?? 4;
    this.sim = opts.similarity ?? 0.4;
    this.maxChildren = opts.maxChildren ?? 100;
    this.maxClusters = opts.maxClustersPerService ?? 5000;
    this.maxTokens = opts.maxTokens ?? 512;
  }

  mine(service: string, message: string): Mined {
    const tokens = message.split(" ");
    if (tokens.length > this.maxTokens) return this.verbatim(service);
    const leaf = this.leaf(service, tokens);
    const match = this.bestMatch(leaf.clusters, tokens);
    if (match) {
      match.count += 1;
      let changed = false;
      const next = match.tokens.map((t, i) => {
        if (t === WILDCARD || t === tokens[i]) return t;
        changed = true;
        return WILDCARD;
      });
      if (changed) {
        match.tokens = next;
        match.versions.push(next);
      }
      return { templateId: match.id, version: match.versions.length - 1, params: paramsOf(match.tokens, tokens), isNew: false };
    }
    const used = this.perService.get(service) ?? 0;
    if (used >= this.maxClusters) return this.verbatim(service);
    this.perService.set(service, used + 1);
    const initial = tokens.map((t) => (isValueToken(t) ? WILDCARD : t));
    const cluster: Cluster = { id: this.byId.length, service, tokens: initial, versions: [initial], count: 1 };
    this.byId.push(cluster);
    leaf.clusters.push(cluster);
    return { templateId: cluster.id, version: 0, params: paramsOf(initial, tokens), isNew: true };
  }

  /** The original message for a stored row. */
  reconstruct(templateId: number, version: number, params: string[]): string {
    const c = this.byId[templateId];
    const tokens = c?.versions[version];
    if (!tokens) throw new Error(`unknown template ${templateId} version ${version}`);
    let p = 0;
    return tokens.map((t) => (t === WILDCARD ? (params[p++] ?? "") : t)).join(" ");
  }

  template(templateId: number): string {
    return this.byId[templateId]?.tokens.join(" ") ?? "";
  }

  get size(): number {
    return this.byId.length;
  }

  snapshot(): TemplateInfo[] {
    return this.byId.map((c) => ({ id: c.id, service: c.service, versions: c.versions, count: c.count }));
  }

  /** Rebuild exactly the state a snapshot was taken from (tree shape included). */
  static restore(infos: TemplateInfo[], opts: MinerOptions = {}): TemplateMiner {
    const m = new TemplateMiner(opts);
    for (const info of infos) {
      const tokens = info.versions[info.versions.length - 1] ?? [];
      const cluster: Cluster = { id: info.id, service: info.service, tokens, versions: info.versions, count: info.count };
      m.byId[info.id] = cluster;
      m.perService.set(info.service, (m.perService.get(info.service) ?? 0) + 1);
      m.leaf(info.service, info.versions[0] ?? []).clusters.push(cluster);
    }
    return m;
  }

  private verbatim(service: string): Mined {
    this.verbatimByService.set(service, (this.verbatimByService.get(service) ?? 0) + 1);
    return { templateId: -1, version: 0, params: [], isNew: false };
  }

  /** Drain's prefix tree: length, then the first depth-2 tokens (value tokens share one branch). */
  private leaf(service: string, tokens: string[]): Node {
    let node = this.roots.get(service);
    if (!node) {
      node = { children: new Map(), clusters: [] };
      this.roots.set(service, node);
    }
    node = child(node, String(tokens.length));
    for (let i = 0; i < Math.min(this.depth - 2, tokens.length); i++) {
      const t = tokens[i] ?? "";
      const key = isValueToken(t) ? WILDCARD : t;
      const full = !node.children.has(key) && node.children.size >= this.maxChildren;
      node = child(node, full ? WILDCARD : key);
    }
    return node;
  }

  private bestMatch(clusters: Cluster[], tokens: string[]): Cluster | null {
    let best: Cluster | null = null;
    let bestSim = -1;
    let bestParams = -1;
    for (const c of clusters) {
      let same = 0;
      let params = 0;
      for (let i = 0; i < tokens.length; i++) {
        const t = c.tokens[i];
        if (t === WILDCARD) params += 1;
        else if (t === tokens[i] || (isValueToken(t ?? "") && isValueToken(tokens[i] ?? ""))) same += 1;
      }
      const sim = same / tokens.length;
      if (sim > bestSim || (sim === bestSim && params > bestParams)) {
        best = c;
        bestSim = sim;
        bestParams = params;
      }
    }
    return best && bestSim >= this.sim ? best : null;
  }
}

function child(node: Node, key: string): Node {
  let next = node.children.get(key);
  if (!next) {
    next = { children: new Map(), clusters: [] };
    node.children.set(key, next);
  }
  return next;
}

function paramsOf(template: string[], tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < template.length; i++) if (template[i] === WILDCARD) out.push(tokens[i] ?? "");
  return out;
}
