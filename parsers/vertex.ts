import { col, htmlTables, isModelId, normalizeSpace, parseDate } from "../src/lib/text.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, DatePrecision, SourceDef } from "../src/types.ts";

const PAGE = "https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions";
const ROUTE = "google-vertex";

export const vertex: SourceDef = {
  id: "vertex",
  kind: "primary",
  // hl=en: without it the site may redirect to a machine-translated page whose headers do not match.
  files: { "model-versions.html": `${PAGE}?hl=en` },
  parse(pages) {
    const tables = htmlTables(pages["model-versions.html"]).filter((t) => col(t.headers, /Model ID/) >= 0 && col(t.headers, /Retirement date/) >= 0);
    if (tables.length < 3) throw new ParseMismatchError("vertex", `expected at least 3 model tables, found ${tables.length}`);
    if (!tables.some((t) => /Retired models/.test(groupOf(t.headingTrail)))) {
      throw new ParseMismatchError("vertex", "the Retired models table is missing");
    }

    const out = new Map<string, Candidate>();
    for (const table of tables) {
      const precision = precisionFor(groupOf(table.headingTrail));
      const modelCol = col(table.headers, /Model ID/);
      const dateCol = col(table.headers, /Retirement date/);
      const replCol = col(table.headers, /Replacement|Recommended upgrade/);
      for (const row of table.rows) {
        const model = normalizeSpace(row[modelCol] ?? "");
        const effective = parseDate(row[dateCol] ?? "");
        if (!isModelId(model) || !effective || out.has(model)) continue;
        const replacementText = row[replCol] ?? "";
        const [to, ...others] = replacementText.split(/\s+or\s+|,\s*/).map((s) => s.trim()).filter(isModelId);
        out.set(model, {
          type: "retirement",
          provider: "google",
          route: ROUTE,
          model,
          ...(to ? { to } : {}),
          effective,
          date_precision: precision,
          successor_basis: to ? "provider_named" : "none",
          source: PAGE,
          ...(others.length ? { notes: `The provider also names: ${others.join(", ")}.` } : {}),
        });
      }
    }
    if (out.size < 10) throw new ParseMismatchError("vertex", `expected at least 10 dated models, found ${out.size}`);
    return { candidates: [...out.values()] };
  },
};

/** Tables sit under product headings ("Gemini models") nested inside a lifecycle heading. */
function groupOf(trail: string[]): string {
  return [...trail].reverse().find((h) => /at least 12 months|shorter availability|Retired models/.test(h)) ?? "";
}

function precisionFor(group: string): DatePrecision {
  // The 12-month group: Google says dates may be extended but never moved earlier.
  if (/at least 12 months/.test(group)) return "earliest_possible";
  return "exact";
}
