/**
 * Mine templates from Loghub-2.0 message contents (one per line, header already removed by the
 * benchmark's own structured file), with Sift's online miner at its default settings, and write
 * each line's template id (Int32, line order). Grouping accuracy is scored in Python.
 *
 * Usage: tsx bench/grouping.ts --contents <file> --ids <bin>
 */
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { TemplateMiner } from "../src/templates/drain.js";

const { values } = parseArgs({ options: { contents: { type: "string" }, ids: { type: "string" } } });
const miner = new TemplateMiner();
const ids: number[] = [];
let rest = "";
const t0 = performance.now();
for await (const chunk of createReadStream(values.contents!, { encoding: "utf8", highWaterMark: 1 << 22 })) {
  const parts = (rest + (chunk as string)).split("\n");
  rest = parts.pop() ?? "";
  for (const line of parts) ids.push(miner.mine("x", line).templateId);
}
if (rest.length) ids.push(miner.mine("x", rest).templateId);
await writeFile(values.ids!, Buffer.from(Int32Array.from(ids).buffer));
process.stdout.write(`${JSON.stringify({ lines: ids.length, seconds: Math.round((performance.now() - t0) / 100) / 10 })}\n`);
