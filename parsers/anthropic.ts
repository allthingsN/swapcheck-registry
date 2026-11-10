import { col, idsIn, mdSections, mdTables, parseDate } from "../src/lib/text.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, SourceDef } from "../src/types.ts";

const PAGE = "https://platform.claude.com/docs/en/about-claude/model-deprecations";
const ROUTE = "anthropic-api";

export const anthropic: SourceDef = {
  id: "anthropic",
  kind: "primary",
  files: { "model-deprecations.md": `${PAGE}.md` },
  parse(pages) {
    const sections = mdSections(pages["model-deprecations.md"]);
    const candidates = new Map<string, Candidate>();

    const status = sections.find((s) => s.title === "Model status");
    const statusTable = status && mdTables(status.body).find((t) => col(t.headers, /Current state/) >= 0);
    if (!statusTable) throw new ParseMismatchError("anthropic", "the Model status table is missing");
    const nameCol = col(statusTable.headers, /API model name/);
    const stateCol = col(statusTable.headers, /Current state/);
    const retireCol = col(statusTable.headers, /retirement/i);
    if (nameCol < 0 || retireCol < 0) throw new ParseMismatchError("anthropic", "the Model status table columns changed");
    if (statusTable.rows.length < 10) throw new ParseMismatchError("anthropic", "the Model status table has too few rows");

    // Deprecation history gives dates and named replacements.
    for (const section of sections) {
      if (!/^\d{4}-\d{2}-\d{2}:/.test(section.title)) continue;
      const announced = section.title.slice(0, 10);
      for (const table of mdTables(section.body)) {
        const dateCol = col(table.headers, /Retirement date/);
        const modelCol = col(table.headers, /Deprecated model/);
        const replCol = col(table.headers, /Recommended replacement/);
        if (dateCol < 0 || modelCol < 0) continue;
        for (const row of table.rows) {
          const effective = parseDate(row[dateCol]);
          for (const model of idsIn(row[modelCol])) {
            const [to] = idsIn(row[replCol] ?? "");
            candidates.set(`retirement:${model}`, {
              type: "retirement",
              provider: "anthropic",
              route: ROUTE,
              model,
              ...(to ? { to } : {}),
              ...(effective ? { effective, date_precision: "exact" as const } : {}),
              successor_basis: to ? "provider_named" : "none",
              source: PAGE,
              notes: `Deprecated ${announced}.`,
            });
          }
        }
      }
    }

    const live: string[] = [];
    for (const row of statusTable.rows) {
      const model = row[nameCol].replace(/`/g, "").trim();
      const state = row[stateCol].trim();
      if (state !== "Retired") live.push(model);
      // "Not sooner than" on an active model is a guaranteed floor, not an announced retirement.
      if (state === "Deprecated" && !candidates.has(`retirement:${model}`)) {
        candidates.set(`retirement:${model}`, {
          type: "retirement",
          provider: "anthropic",
          route: ROUTE,
          model,
          successor_basis: "none",
          source: PAGE,
          notes: "Deprecated with a retirement date still to be announced.",
        });
      }
    }

    const params = sections.find((s) => s.title === "API parameter deprecations");
    const paramTable = params && mdTables(params.body).find((t) => col(t.headers, /^Parameter/) >= 0);
    if (!paramTable) throw new ParseMismatchError("anthropic", "the API parameter deprecations table is missing");
    let removals = 0;
    for (const row of paramTable.rows) {
      const names = idsIn(row[0]);
      const version = /Removed in .*?`(\d{4}-\d{2}-\d{2})`/.exec(row[1] ?? "");
      if (!names.length || !version || !/400/.test(row[2] ?? "")) continue;
      removals++;
      for (const model of live) {
        candidates.set(`param:${model}:${version[1]}`, {
          type: "parameter_change",
          provider: "anthropic",
          route: ROUTE,
          model,
          effective: version[1],
          date_precision: "exact",
          params: names,
          source: `${PAGE}#api-parameter-deprecations`,
          notes: `Removed in API version ${version[1]}; requests that send these return a 400 error. The date is an API version, so it applies when a request uses that version or later.`,
          variant: version[1],
        });
      }
    }
    if (!removals) throw new ParseMismatchError("anthropic", "no parameter removal was recognized");
    if (candidates.size < 15) throw new ParseMismatchError("anthropic", "too few events were found");
    return { candidates: [...candidates.values()] };
  },
};
