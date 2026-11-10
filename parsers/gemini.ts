import { daysBetween, idsIn, isModelId, mdSections, normalizeSpace, parseDate, unlink } from "../src/lib/text.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, SourceDef } from "../src/types.ts";

const PAGE = "https://aistudio.google.com/docs/deprecations";
const ROUTE = "google-ai-studio";
const NEW_MODEL_WINDOW_DAYS = 45;

interface Row {
  model: string;
  release: string;
  shutdown: string;
  replacement: string;
}

/** Markdoc tables: `{% table %}`, rows split by `---`, cells prefixed by `* `. */
function markdocTables(body: string): Row[][] {
  const tables: Row[][] = [];
  for (const m of body.matchAll(/\{%\s*table\s*%\}([\s\S]*?)\{%\s*\/table\s*%\}/g)) {
    const rawRows = m[1].split(/\n\s*---\s*\n/);
    const rows: Row[] = [];
    for (const raw of rawRows.slice(1)) {
      const cells: string[] = [];
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith("*")) cells.push(t.replace(/^\*\s*/, ""));
        else if (cells.length) cells[cells.length - 1] += ` ${t}`;
      }
      if (cells.length < 3) continue;
      const [model] = idsIn(cells[0]);
      if (!model) continue;
      rows.push({
        model,
        release: normalizeSpace(cells[1] ?? ""),
        shutdown: normalizeSpace(cells[2] ?? ""),
        replacement: normalizeSpace(cells[3] ?? ""),
      });
    }
    tables.push(rows);
  }
  return tables;
}

interface Callout {
  effective: string;
  to: string;
  billing: "replacement_rates" | "unknown";
}

/** "Effective December 1, 2026, all API requests to `X` will automatically route to `Y`". */
function parseCallout(sectionBody: string, calloutsOut: Map<string, Callout>): void {
  const text = normalizeSpace(unlink(sectionBody));
  const re = /Effective ([A-Z][a-z]+ \d{1,2}, \d{4}), all API requests to `([^`]+)` will automatically route to `([^`]+)`(.{0,120})/g;
  for (const m of text.matchAll(re)) {
    const effective = parseDate(m[1]);
    if (!effective || !isModelId(m[2]) || !isModelId(m[3])) continue;
    calloutsOut.set(m[2], { effective, to: m[3], billing: /billed at/.test(m[4]) ? "replacement_rates" : "unknown" });
  }
}

export const gemini: SourceDef = {
  id: "gemini",
  kind: "primary",
  files: { "deprecations.md": `${PAGE}.md` },
  parse(pages, ctx) {
    const md = pages["deprecations.md"];
    if (!/earliest possible/.test(normalizeSpace(md))) {
      throw new ParseMismatchError("gemini", "the note saying dates are the earliest possible is gone, so date precision cannot be assigned");
    }
    const sections = mdSections(md).filter((s) => !/Managed agents/.test(s.title) && !s.parents.some((p) => /Managed agents/.test(p)));
    const callouts = new Map<string, Callout>();
    for (const section of sections) parseCallout(section.body, callouts);

    const out = new Map<string, Candidate>();
    let rowsSeen = 0;
    for (const section of sections) {
      const isDeprecatedTable = /^Deprecated models?$/i.test(section.title);
      for (const rows of markdocTables(section.body)) {
        for (const row of rows) {
          rowsSeen++;
          addRow(out, row, isDeprecatedTable, callouts.get(row.model));
          const released = parseDate(row.release);
          if (released && !isDeprecatedTable) {
            const age = daysBetween(released, ctx.today);
            if (age >= 0 && age <= NEW_MODEL_WINDOW_DAYS) {
              out.set(`new:${row.model}`, {
                type: "new_model",
                provider: "google",
                route: ROUTE,
                model: row.model,
                effective: released,
                date_precision: "exact",
                source: PAGE,
              });
            }
          }
        }
      }
    }
    if (rowsSeen < 40 || callouts.size < 2) {
      throw new ParseMismatchError("gemini", `expected at least 40 table rows and 2 reroute callouts, found ${rowsSeen} and ${callouts.size}`);
    }
    return { candidates: [...out.values()] };
  },
};

function addRow(out: Map<string, Candidate>, row: Row, isDeprecatedTable: boolean, callout: Callout | undefined): void {
  const key = `event:${row.model}`;
  if (out.has(key)) return;
  const replacementIds = idsIn(row.replacement);
  const reroute = rerouteFrom(row.replacement);

  if (callout || reroute) {
    const to = callout?.to ?? reroute!.to;
    const effective = callout?.effective ?? reroute!.effective;
    out.set(key, {
      type: "reroute",
      provider: "google",
      route: ROUTE,
      model: row.model,
      to,
      ...(effective ? { effective, date_precision: "exact" as const } : {}),
      billing: callout?.billing ?? "unknown",
      successor_basis: "provider_named",
      source: PAGE,
      notes: effective
        ? "Requests route to the replacement automatically on this date; the provider states it in a dated notice, which is more specific than the page's general earliest-possible note for shutdown dates."
        : "The provider's page says requests already route to the replacement; it does not give the date this began.",
    });
    return;
  }

  const effective = parseDate(row.shutdown);
  if (!effective) return;
  const [to, ...others] = replacementIds;
  out.set(key, {
    type: "retirement",
    provider: "google",
    route: ROUTE,
    model: row.model,
    ...(to ? { to } : {}),
    effective,
    date_precision: isDeprecatedTable ? "exact" : "earliest_possible",
    successor_basis: to ? "provider_named" : "none",
    source: PAGE,
    ...(others.length ? { notes: `The provider also names: ${others.join(", ")}.` } : {}),
  });
}

function rerouteFrom(cell: string): { to: string; effective?: string } | null {
  if (!/rout(e|es|ing)\b/i.test(cell)) return null;
  const target = /rout(?:e|es|ing)(?: API requests)? to `([^`]+)`/i.exec(cell);
  if (!target || !isModelId(target[1])) return null;
  const when = /effective ([A-Z][a-z]+ \d{1,2}, \d{4})/i.exec(cell);
  const effective = when ? parseDate(when[1]) : null;
  return { to: target[1], ...(effective ? { effective } : {}) };
}
