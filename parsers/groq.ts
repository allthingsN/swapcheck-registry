import { col, isModelId, mdSections, mdTables, parseDate, unlink } from "../src/lib/text.ts";
import { vendorFor } from "../src/lib/vendor.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, SourceDef } from "../src/types.ts";

const PAGE = "https://console.groq.com/docs/deprecations";

export const groq: SourceDef = {
  id: "groq",
  kind: "primary",
  files: { "deprecations.md": `${PAGE}.md` },
  parse(pages) {
    const sections = mdSections(pages["deprecations.md"]);
    if (!sections.some((s) => /Deprecation History/.test(s.title))) {
      throw new ParseMismatchError("groq", "the Deprecation History heading is missing");
    }
    const out = new Map<string, Candidate>();
    for (const section of sections) {
      for (const table of mdTables(section.body)) {
        const modelCol = col(table.headers, /Deprecated Model|^Model/i);
        const dateCol = col(table.headers, /Shutdown Date/i);
        const replCol = col(table.headers, /Replacement/i);
        if (modelCol < 0 || dateCol < 0) continue;
        for (const row of table.rows) {
          const model = unlink(row[modelCol] ?? "").replace(/`/g, "").trim();
          const effective = parseDate(row[dateCol] ?? "");
          if (!isModelId(model) || !effective || out.has(model)) continue;
          const [to, ...others] = unlink(row[replCol] ?? "")
            .replace(/`/g, "")
            .split(/\s+or\s+|,\s*/)
            .map((s) => s.trim())
            .filter(isModelId);
          out.set(model, {
            type: "retirement",
            provider: vendorFor(model, "groq"),
            route: "groq-api",
            model,
            ...(to ? { to } : {}),
            effective,
            date_precision: "exact",
            successor_basis: to ? "provider_named" : "none",
            source: PAGE,
            ...(others.length ? { notes: `The provider also names: ${others.join(", ")}.` } : {}),
          });
        }
      }
    }
    if (out.size < 15) throw new ParseMismatchError("groq", `expected at least 15 models, found ${out.size}`);
    return { candidates: [...out.values()] };
  },
};
