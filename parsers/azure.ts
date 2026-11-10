import { col, isModelId, mdSections, mdTables, parseFootnotedIsoDate } from "../src/lib/text.ts";
import { vendorFromName } from "../src/lib/vendor.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, DatePrecision, SourceDef } from "../src/types.ts";

const PAGE = "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule";
const ROUTE = "azure-foundry";
const IN_SCOPE = /Foundry Models (sold by Azure|from partners and community)/;

export const azure: SourceDef = {
  id: "azure",
  kind: "primary",
  files: { "model-retirement-schedule.md": `${PAGE}?accept=text/markdown` },
  parse(pages) {
    const sections = mdSections(pages["model-retirement-schedule.md"]);
    if (!sections.some((s) => IN_SCOPE.test(s.title))) {
      throw new ParseMismatchError("azure", "the Foundry Models section headings are missing");
    }
    const out = new Map<string, Candidate>();
    const unreadable: string[] = [];
    for (const section of sections) {
      if (!section.parents.some((p) => IN_SCOPE.test(p)) || /Fine-tuned/i.test(section.title)) continue;
      const provider = vendorFromName(section.title, section.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      for (const table of mdTables(section.body)) {
        const modelCol = col(table.headers, /^Model$/);
        const versionCol = col(table.headers, /^Version$/);
        const lifecycleCol = col(table.headers, /^Lifecycle$/);
        const dateCol = col(table.headers, /Retirement date/);
        const replCol = col(table.headers, /^Replacement$/);
        if (modelCol < 0 || dateCol < 0) continue;
        for (const row of table.rows) {
          const name = (row[modelCol] ?? "").replace(/`/g, "").trim();
          const version = (row[versionCol] ?? "").trim();
          const effective = parseFootnotedIsoDate(row[dateCol] ?? "");
          if (!effective && /\d/.test(row[dateCol] ?? "")) unreadable.push(name);
          if (!isModelId(name) || !effective) continue;
          const dated = /^\d{4}-\d{2}-\d{2}$/.test(version);
          const model = dated ? `${name}-${version}` : name;
          const variant = dated || !version ? undefined : `v${version}`;
          const lifecycle = (row[lifecycleCol] ?? "").trim();
          const to = replacementFrom(row[replCol] ?? "");
          out.set(`${provider}:${model}:${variant ?? ""}`, {
            type: "retirement",
            provider,
            route: ROUTE,
            model,
            ...(to ? { to } : {}),
            effective,
            date_precision: precisionFor(lifecycle),
            successor_basis: to ? "provider_named" : "none",
            source: PAGE,
            notes: `Azure lifecycle stage: ${lifecycle || "not stated"}.${version && !dated ? ` Azure version ${version}.` : ""}${/\^\d+\^/.test(row[dateCol] ?? "") ? " Azure footnotes this date; deployment types can differ, so check the schedule." : ""}`,
            ...(variant ? { variant } : {}),
          });
        }
      }
    }
    if (out.size < 30) throw new ParseMismatchError("azure", `expected at least 30 models with dates, found ${out.size}`);
    return {
      candidates: [...out.values()],
      warnings: unreadable.length ? [`azure: could not read the retirement date for: ${unreadable.slice(0, 10).join(", ")}.`] : [],
    };
  },
};

function replacementFrom(cell: string): string | undefined {
  const token = /^([A-Za-z0-9][\w.:/-]*)/.exec(cell.replace(/`/g, "").trim())?.[1];
  // A bare word such as "None" is not a model name; real IDs contain a digit or hyphen.
  return token && isModelId(token) && /[\d-]/.test(token) ? token : undefined;
}

function precisionFor(lifecycle: string): DatePrecision {
  // Azure says schedule dates are subject to change; the GA/Preview dates are plans, not retirements in progress.
  return /^(Deprecated|Legacy|Retired)$/i.test(lifecycle) ? "exact" : "estimated";
}
