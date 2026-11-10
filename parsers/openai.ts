import { col, idsIn, isModelId, mdSections, mdTables, parseDate } from "../src/lib/text.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, SourceDef } from "../src/types.ts";

const PAGE = "https://developers.openai.com/api/docs/deprecations";

export const openai: SourceDef = {
  id: "openai",
  kind: "primary",
  files: { "deprecations.md": `${PAGE}.md` },
  parse(pages) {
    const sections = mdSections(pages["deprecations.md"]);
    if (!sections.some((s) => s.title === "Upcoming deprecations")) {
      throw new ParseMismatchError("openai", "the Upcoming deprecations heading is missing");
    }
    const out = new Map<string, Candidate>();
    for (const section of sections) {
      for (const table of mdTables(section.body)) {
        const dateCol = col(table.headers, /Shutdown date|Sunset date/i);
        const modelCol = table.headers.findIndex((h) => /model|system/i.test(h) && !/price|replacement|substitute/i.test(h));
        const replCol = col(table.headers, /replacement|substitute/i);
        if (dateCol < 0 || modelCol < 0) continue;
        for (const row of table.rows) {
          const effective = parseDate((row[dateCol] ?? "").replace(/\s*\(.*\)$/, ""));
          if (!effective) continue;
          for (const model of modelIdsIn(row[modelCol] ?? "")) {
            if (out.has(model)) continue;
            const replacement = row[replCol] ?? "";
            const [to, ...others] = idsIn(replacement).filter((id) => !id.startsWith("/"));
            const mode = /`reasoning\.mode: (\w+)`/.exec(replacement);
            const notes = [
              others.length ? `The provider also names: ${others.join(", ")}.` : "",
              mode ? `Use reasoning.mode: ${mode[1]} on the replacement.` : "",
            ].filter(Boolean).join(" ");
            out.set(model, {
              type: "retirement",
              provider: "openai",
              route: "openai-api",
              model,
              ...(to ? { to } : {}),
              effective,
              date_precision: "exact",
              successor_basis: to ? "provider_named" : "none",
              source: PAGE,
              ...(notes ? { notes } : {}),
            });
          }
        }
      }
    }
    if (out.size < 30) throw new ParseMismatchError("openai", `expected at least 30 model rows, found ${out.size}`);
    return { candidates: [...out.values()] };
  },
};

function modelIdsIn(cell: string): string[] {
  const ticked = idsIn(cell).filter((id) => !id.startsWith("/") && !id.startsWith("v1/"));
  if (ticked.length) return ticked;
  // Old rows sometimes omit backticks: accept a bare ID, reject prose like "GPT base models".
  const bare = cell.trim();
  return isModelId(bare) && /[-0-9]/.test(bare) && !bare.startsWith("/") ? [bare] : [];
}
