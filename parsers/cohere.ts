import { col, idsIn, isModelId, mdSections, mdTables, normalizeSpace, parseDate } from "../src/lib/text.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, SourceDef } from "../src/types.ts";

const PAGE = "https://docs.cohere.com/docs/deprecations";
const NON_MODELS = new Set(["summarize"]);

export const cohere: SourceDef = {
  id: "cohere",
  kind: "primary",
  files: { "deprecations.md": `${PAGE}.md` },
  parse(pages) {
    const sections = mdSections(pages["deprecations.md"]);
    if (!sections.some((s) => s.title === "Deprecation History")) {
      throw new ParseMismatchError("cohere", "the Deprecation History heading is missing");
    }
    const out = new Map<string, Candidate>();
    for (const section of sections) {
      if (!/^\d{4}-\d{2}-\d{2}:/.test(section.title)) continue;
      const text = normalizeSpace(section.body);
      // The prose date is the effective date; the heading is the announcement.
      const prose = /Effective ([A-Z][a-z]+ \d{1,2}(?:st|nd|rd|th)?,? \d{4})/.exec(text);
      const effective = prose ? parseDate(prose[1]) : null;
      for (const table of mdTables(section.body)) {
        const dateCol = col(table.headers, /Shutdown Date/i);
        const modelCol = col(table.headers, /Deprecated Model$/i);
        const replCol = col(table.headers, /Recommended Replacement/i);
        if (dateCol < 0 || modelCol < 0) continue;
        for (const row of table.rows) {
          const date = parseDate(row[dateCol] ?? "");
          const [model] = idsIn(row[modelCol] ?? "");
          const [to] = idsIn(row[replCol] ?? "");
          if (!date || !model) continue;
          out.set(model, base(model, date, to));
        }
      }
      if (!effective) continue;
      const bullets = section.body.split("\n");
      const listStart = bullets.findIndex((l) => /following models will be retired|^Deprecated Models:/i.test(l.trim()));
      if (listStart < 0) continue;
      for (const line of bullets.slice(listStart + 1)) {
        if (/^(Retired Fine-Tuning|Deprecated Features|We encourage|For command|These changes)/.test(line.trim())) break;
        const bullet = /^\*\s+(.*)$/.exec(line.trim());
        if (!bullet) continue;
        for (const model of idsIn(bullet[1])) {
          if (isModelId(model) && !NON_MODELS.has(model)) out.set(model, base(model, effective));
        }
      }
    }
    if (out.size < 8) throw new ParseMismatchError("cohere", `expected at least 8 models, found ${out.size}`);
    return { candidates: [...out.values()] };
  },
};

function base(model: string, effective: string, to?: string): Candidate {
  return {
    type: "retirement",
    provider: "cohere",
    route: "cohere-api",
    model,
    ...(to ? { to } : {}),
    effective,
    date_precision: "exact",
    successor_basis: to ? "provider_named" : "none",
    source: PAGE,
    ...(to ? {} : { notes: "Cohere recommends a set of alternatives rather than one named replacement." }),
  };
}
