import { col, idsIn, mdSections, mdTables, parseDate } from "../src/lib/text.ts";
import { vendorFor } from "../src/lib/vendor.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, SourceDef } from "../src/types.ts";

const PAGE = "https://docs.together.ai/docs/deprecations";

export const together: SourceDef = {
  id: "together",
  kind: "primary",
  files: { "deprecations.md": `${PAGE}.md` },
  parse(pages) {
    const sections = mdSections(pages["deprecations.md"]);
    const get = (title: string) => sections.find((s) => s.title === title);
    const redirects = get("Active model redirects");
    const scheduled = get("Scheduled deprecations");
    const inference = sections.find((s) => s.title === "Inference" && s.parents.includes("Deprecation history"));
    if (!redirects || !scheduled || !inference) throw new ParseMismatchError("together", "expected redirect, schedule and history sections");

    const out = new Map<string, Candidate>();
    for (const table of mdTables(redirects.body)) {
      const fromCol = col(table.headers, /Original model/);
      const toCol = col(table.headers, /Redirects to/);
      if (fromCol < 0 || toCol < 0) continue;
      for (const row of table.rows) {
        const [model] = idsIn(row[fromCol] ?? "");
        const [to] = idsIn(row[toCol] ?? "");
        if (model && to) {
          out.set(`reroute:${model}`, {
            type: "reroute",
            provider: vendorFor(model, "together"),
            route: "together-api",
            model,
            to,
            billing: "unknown",
            successor_basis: "provider_named",
            source: PAGE,
            notes: "Listed as an active redirect; the page does not give the date it began.",
          });
        }
      }
    }

    // History records actual removals, so it runs last and overrides a planned date for the same model.
    for (const [section, withReplacement] of [[scheduled, true], [inference, false]] as const) {
      for (const table of mdTables(section.body)) {
        const dateCol = col(table.headers, /Removal date/);
        const modelCol = col(table.headers, /^Model$/);
        const replCol = col(table.headers, /Recommended replacement/);
        if (dateCol < 0 || modelCol < 0) continue;
        for (const row of table.rows) {
          const effective = parseDate(row[dateCol] ?? "");
          const [model] = idsIn(row[modelCol] ?? "");
          if (!effective || !model) continue;
          const [to] = withReplacement ? idsIn(row[replCol] ?? "") : [];
          const prior = out.get(`retire:${model}`);
          out.set(`retire:${model}`, {
            type: "retirement",
            provider: vendorFor(model, "together"),
            route: "together-api",
            model,
            ...((to ?? prior?.to) ? { to: to ?? prior?.to } : {}),
            effective,
            date_precision: "exact",
            successor_basis: (to ?? prior?.to) ? "provider_named" : "none",
            source: PAGE,
            notes: withReplacement ? "Scheduled removal from serverless inference." : "Removed from serverless inference.",
          });
        }
      }
    }
    if (out.size < 20) throw new ParseMismatchError("together", `expected at least 20 events, found ${out.size}`);
    return { candidates: [...out.values()] };
  },
};
