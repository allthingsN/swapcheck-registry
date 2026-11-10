import { col, idsIn, mdSections, mdTables, parseDate } from "../src/lib/text.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, SourceDef } from "../src/types.ts";

const PAGE = "https://docs.mistral.ai/models";

export const mistral: SourceDef = {
  id: "mistral",
  kind: "primary",
  files: { "models.md": `${PAGE}.md` },
  parse(pages) {
    const sections = mdSections(pages["models.md"]);
    const section = sections.find((s) => /Deprecated and retired models/.test(s.title));
    const table = section && mdTables(section.body).find((t) => col(t.headers, /Retirement/) >= 0);
    if (!table) throw new ParseMismatchError("mistral", "the Deprecated and retired models table is missing");

    // Replacement cells link to a model page; map that slug to its callable API name.
    const slugToApiName = new Map<string, string>();
    for (const s of sections) {
      for (const t of mdTables(s.body)) {
        const apiCol = col(t.headers, /API name/);
        const modelCol = col(t.headers, /^Model$/);
        if (apiCol < 0 || modelCol < 0) continue;
        for (const row of t.rows) {
          const slug = /\(\/models\/([^)]+)\)/.exec(row[modelCol] ?? "")?.[1];
          const [apiName] = idsIn(row[apiCol] ?? "");
          if (slug && apiName && !slugToApiName.has(slug)) slugToApiName.set(slug, apiName);
        }
      }
    }

    const nameCol = col(table.headers, /API name/);
    const statusCol = col(table.headers, /Status/);
    const depCol = col(table.headers, /Deprecation/);
    const retireCol = col(table.headers, /Retirement/);
    const replCol = col(table.headers, /Replacement/);
    if (nameCol < 0 || retireCol < 0 || replCol < 0) throw new ParseMismatchError("mistral", "the table columns changed");

    const out = new Map<string, Candidate>();
    for (const row of table.rows) {
      const [model] = idsIn(row[nameCol] ?? "");
      const effective = parseDate(row[retireCol] ?? "");
      if (!model || !effective || out.has(model)) continue;
      const slug = /\(\/models\/([^)]+)\)/.exec(row[replCol] ?? "")?.[1];
      const to = slug ? slugToApiName.get(slug) : undefined;
      const deprecated = parseDate(row[depCol] ?? "");
      out.set(model, {
        type: "retirement",
        provider: "mistral",
        route: "mistral-api",
        model,
        ...(to ? { to } : {}),
        effective,
        date_precision: "exact",
        successor_basis: to ? "provider_named" : "none",
        source: PAGE,
        notes: `Status on page: ${(row[statusCol] ?? "").trim()}.${deprecated ? ` Deprecated ${deprecated}.` : ""}`,
      });
    }
    if (out.size < 15) throw new ParseMismatchError("mistral", `expected at least 15 dated models, found ${out.size}`);
    return { candidates: [...out.values()] };
  },
};
