/**
 * Re-records fixtures from the live sources:  node scripts/record-fixtures.ts [source-id ...]
 * Large JSON sources are trimmed to the parts the parser reads so the repo stays small;
 * the trimmed file keeps the original shape.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCES } from "../parsers/index.ts";
import { ROUTES } from "../parsers/models-dev.ts";
import { fetchText } from "../src/lib/fetch.ts";

const root = join(import.meta.dirname, "..", "fixtures");
const only = new Set(process.argv.slice(2));

function trim(sourceId: string, body: string): string {
  if (sourceId === "models-dev") {
    const data = JSON.parse(body);
    return JSON.stringify(Object.fromEntries(Object.keys(ROUTES).map((k) => [k, data[k]])));
  }
  if (sourceId === "litellm") {
    const data = JSON.parse(body) as Record<string, { deprecation_date?: string; successor_model?: string }>;
    return JSON.stringify(Object.fromEntries(Object.entries(data).filter(([k, v]) => k !== "sample_spec" && v && (v.deprecation_date || v.successor_model))));
  }
  return body;
}

for (const source of SOURCES) {
  if (only.size && !only.has(source.id)) continue;
  mkdirSync(join(root, source.id), { recursive: true });
  const pages: Record<string, string> = {};
  for (const [file, url] of Object.entries(source.files)) {
    pages[file] = trim(source.id, await fetchText(url, file));
    writeFileSync(join(root, source.id, file), pages[file]);
  }
  try {
    const result = source.parse(pages, { today: new Date().toISOString().slice(0, 10) });
    process.stdout.write(`recorded ${source.id}: ${result.candidates.length} events\n`);
  } catch (err) {
    // Recording a page the parser cannot read is the first step of fixing that parser.
    process.stdout.write(`recorded ${source.id}, but the parser does not match it: ${(err as Error).message}\n`);
  }
}
