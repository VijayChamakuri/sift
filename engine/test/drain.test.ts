import { describe, expect, it } from "vitest";

import { TemplateMiner, WILDCARD } from "../src/templates/drain.js";

describe("TemplateMiner", () => {
  it("reconstructs every line byte for byte, including odd whitespace and unicode", () => {
    const m = new TemplateMiner();
    const lines = [
      "user 42 logged in from 10.0.0.1:5000",
      "user 43 logged in from 10.0.0.2:5000",
      "user  44 logged in  from 10.0.0.3",
      "",
      " leading and trailing ",
      "naïve café — ✓ done in 12.5ms",
      "multi\nline\tvalue",
    ];
    const rows = lines.map((l) => ({ l, ...m.mine("svc", l) }));
    for (const r of rows) expect(m.reconstruct(r.templateId, r.version, r.params)).toBe(r.l);
  });

  it("keeps old rows readable after a template generalises (versioned)", () => {
    const m = new TemplateMiner();
    const a = m.mine("svc", "connect to cartservice ok");
    const b = m.mine("svc", "connect to emailservice ok");
    expect(b.templateId).toBe(a.templateId);
    expect(b.version).toBe(a.version + 1);
    expect(m.template(a.templateId)).toBe(`connect to ${WILDCARD} ok`);
    expect(m.reconstruct(a.templateId, a.version, a.params)).toBe("connect to cartservice ok");
    expect(m.reconstruct(b.templateId, b.version, b.params)).toBe("connect to emailservice ok");
  });

  it("mines per service and online: a template is new the first time its service emits it", () => {
    const m = new TemplateMiner();
    expect(m.mine("a", "request complete").isNew).toBe(true);
    expect(m.mine("a", "request complete").isNew).toBe(false);
    expect(m.mine("b", "request complete").isNew).toBe(true);
  });

  it("restores from a snapshot to the same matching behaviour", () => {
    const m = new TemplateMiner();
    for (let i = 0; i < 50; i++) m.mine("svc", `GET /product/${i} took ${i * 3}ms status 200`);
    m.mine("svc", "cache miss for key abc");
    const r = TemplateMiner.restore(m.snapshot());
    const next = "GET /product/999 took 7ms status 200";
    const x = m.mine("svc", next);
    const y = r.mine("svc", next);
    expect(y.templateId).toBe(x.templateId);
    expect(r.reconstruct(y.templateId, y.version, y.params)).toBe(next);
  });

  it("masks identifier lists, so new ID combinations are not new templates (Dev bias fix)", () => {
    const m = new TemplateMiner();
    const a = m.mine("rec", "[Recv ListRecommendations] product_ids=['2ZYFJ3GM2N', '6E92ZMYYFZ', '1YMWWN1N4O']");
    const b = m.mine("rec", "[Recv ListRecommendations] product_ids=['L9ECAV7KIM', 'OLJCESPC7Z', '9SIQT8TOJO']");
    expect(b.templateId).toBe(a.templateId);
    expect(b.isNew).toBe(false);
    expect(m.reconstruct(b.templateId, b.version, b.params)).toBe("[Recv ListRecommendations] product_ids=['L9ECAV7KIM', 'OLJCESPC7Z', '9SIQT8TOJO']");
    // ordinary words with one digit stay literal
    expect(m.mine("svc", "using http2 transport").isNew).toBe(true);
    expect(m.template(m.mine("svc", "using http2 transport").templateId)).toBe("using http2 transport");
  });

  it("stores lines verbatim past the per-service cap and counts them", () => {
    const m = new TemplateMiner({ maxClustersPerService: 2 });
    m.mine("svc", "alpha one");
    m.mine("svc", "beta two three");
    const over = m.mine("svc", "gamma four five six");
    expect(over.templateId).toBe(-1);
    expect(m.verbatimByService.get("svc")).toBe(1);
  });
});
