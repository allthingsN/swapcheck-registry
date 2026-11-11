import { isModelId, mdSections, normalizeSpace, parseDate } from "../src/lib/text.ts";
import { vendorFromName } from "../src/lib/vendor.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, RegionDate, SourceDef } from "../src/types.ts";

const PAGE = "https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html";
const ROUTE = "aws-bedrock";

interface Item {
  provider: string;
  ids: string[];
  regionRows: Array<{ regions: string; eol: string | null; extended: string | null }>;
}

/** Lifecycle items are bullet blocks; one model can have several region rows on one or more lines. */
function parseItems(block: string): Item[] {
  const items: Item[] = [];
  let current: Item | null = null;
  for (const line of block.split("\n")) {
    const top = /^- \*\*([^*]+)\*\*\s*$/.exec(line);
    if (top) {
      current = { provider: top[1].trim(), ids: [], regionRows: [] };
      items.push(current);
      continue;
    }
    if (!current) continue;
    const text = normalizeSpace(line.replace(/^\s*-\s*/, "").replace(/\*\*/g, ""));
    if (text.startsWith("Model ID:")) {
      current.ids = text
        .slice("Model ID:".length)
        .split(",")
        .map((part) => part.replace(/\([^)]*\)/g, "").trim())
        .filter(isModelId);
      continue;
    }
    if (/^Regions:/.test(text)) {
      const fields = Object.fromEntries(
        text.split(/ \/ (?=[A-Z])/).map((f) => {
          const i = f.indexOf(":");
          return [f.slice(0, i).trim(), f.slice(i + 1).trim()];
        }),
      );
      current.regionRows.push({
        regions: fields["Regions"] ?? "",
        eol: parseDate(fields["EOL date"] ?? ""),
        extended: parseDate(fields["Public extended access start date"] ?? ""),
      });
      continue;
    }
    // Single-region rows split each field across lines.
    if (current.regionRows.length === 0 && /^(Legacy date|Model name):/.test(text)) continue;
    const eol = /^EOL date: (.*)$/.exec(text);
    const ext = /^Public extended access start date: (.*)$/.exec(text);
    if (eol || ext) {
      if (!current.regionRows.length) current.regionRows.push({ regions: "", eol: null, extended: null });
      const row = current.regionRows[0];
      if (eol) row.eol = parseDate(eol[1]);
      if (ext) row.extended = parseDate(ext[1]);
    }
  }
  return items.filter((i) => i.ids.length && i.regionRows.some((r) => r.eol));
}

function earliest(dates: Array<string | null>): string | undefined {
  return dates.filter((d): d is string => !!d).sort()[0];
}

const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

/** The rows' regions with their dates, or undefined when any dated row lacks a readable region list. */
function regionSchedule(rows: Item["regionRows"], pick: (row: Item["regionRows"][number]) => string | null): RegionDate[] | undefined {
  const dated = rows.filter((row) => pick(row));
  const schedule = dated.map((row) => ({ regions: row.regions.split(",").map((r) => r.trim()).filter(Boolean), effective: pick(row) as string }));
  if (!schedule.length || schedule.some((row) => !row.regions.length || !row.regions.every((r) => REGION.test(r)))) return undefined;
  return schedule;
}

export const bedrock: SourceDef = {
  id: "bedrock",
  kind: "primary",
  files: { "model-lifecycle-legacy.md": PAGE.replace(/\.html$/, ".md") },
  parse(pages) {
    const md = pages["model-lifecycle-legacy.md"];
    const lifecycle = mdSections(md).find((s) => /Legacy and end-of-life/.test(s.title));
    if (!lifecycle) throw new ParseMismatchError("bedrock", "the lifecycle section is missing");
    const scheduledStart = lifecycle.body.indexOf("**Models with a scheduled EOL date**");
    const reachedStart = lifecycle.body.indexOf("**Models that have reached EOL**");
    if (scheduledStart < 0 || reachedStart < 0 || reachedStart < scheduledStart) {
      throw new ParseMismatchError("bedrock", "the scheduled and EOL model lists are missing");
    }
    const scheduled = parseItems(lifecycle.body.slice(scheduledStart, reachedStart));
    const reached = parseItems(lifecycle.body.slice(reachedStart));
    if (scheduled.length < 10) throw new ParseMismatchError("bedrock", `expected at least 10 scheduled models, found ${scheduled.length}`);

    const out: Candidate[] = [];
    for (const item of [...scheduled, ...reached]) {
      const isScheduled = scheduled.includes(item);
      const provider = vendorFromName(item.provider, item.provider.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      const effective = earliest(item.regionRows.map((r) => r.eol));
      const distinctDates = new Set(item.regionRows.map((r) => r.eol));
      const eolSchedule = regionSchedule(item.regionRows, (r) => r.eol);
      const extendedSchedule = regionSchedule(item.regionRows, (r) => r.extended);
      for (const model of item.ids) {
        out.push({
          type: "retirement",
          provider,
          route: ROUTE,
          model,
          effective,
          ...(eolSchedule ? { region_schedule: eolSchedule } : {}),
          date_precision: "exact",
          successor_basis: "none",
          source: PAGE,
          notes:
            `${isScheduled ? "Amazon Bedrock schedule; dates are specific to this route." : "Listed as end of life on Amazon Bedrock."}` +
            (distinctDates.size > 1
              ? ` Dates differ by region: ${item.regionRows.map((r) => `${r.regions} on ${r.eol ?? "not stated"}`).join("; ")}. The earliest is shown.`
              : ""),
        });
        const extended = earliest(item.regionRows.map((r) => r.extended));
        if (isScheduled && extended) {
          out.push({
            type: "price_change",
            provider,
            route: ROUTE,
            model,
            effective: extended,
            ...(extendedSchedule ? { region_schedule: extendedSchedule } : {}),
            date_precision: "exact",
            billing: "unknown",
            source: PAGE,
            notes: "Start of public extended access. AWS says to expect higher pricing set by the model provider and does not publish the amount on this page.",
          });
        }
      }
    }
    return { candidates: out };
  },
};
