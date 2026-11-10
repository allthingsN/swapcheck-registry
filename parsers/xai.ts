import { col, idsIn, isModelId, mdTables, normalizeSpace, parseDate } from "../src/lib/text.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, SourceDef } from "../src/types.ts";

const MAY_URL = "https://docs.x.ai/developers/migration/may-15-retirement";
const NOV_URL = "https://docs.x.ai/developers/migration/imagine-image-quality-nov-2";
const KNOWN_MIGRATIONS = new Set(["may-15-retirement", "imagine-image-quality-nov-2"]);

export const xai: SourceDef = {
  id: "xai",
  kind: "primary",
  files: {
    "may-15-retirement.md": `${MAY_URL}.md`,
    "imagine-image-quality-nov-2.md": `${NOV_URL}.md`,
    "llms.txt": "https://docs.x.ai/llms.txt",
  },
  parse(pages) {
    const out: Candidate[] = [];

    const may = pages["may-15-retirement.md"];
    const when = /After \*\*(\w+ \d{1,2}, \d{4})/.exec(may);
    const effective = when ? parseDate(when[1]) : null;
    const billed = /billed at `([^`]+)` pricing/.exec(may);
    const mapping = mdTables(may).find((t) => t.rows.length >= 3 && idsIn(t.rows[0][0] ?? "").length === 1 && idsIn(t.rows[0][1] ?? "").length >= 1);
    if (!effective || !mapping) throw new ParseMismatchError("xai", "the May 15 retirement mapping table is missing");
    for (const row of mapping.rows) {
      const [model] = idsIn(row[0] ?? "");
      const [to] = idsIn(row[1] ?? "");
      if (!model || !to) continue;
      const effort = /with `(\w+)` reasoning effort/.exec(row[1] ?? "");
      out.push({
        type: "reroute",
        provider: "xai",
        route: "xai-api",
        model,
        to,
        effective,
        date_precision: "exact",
        billing: billed && billed[1] === to ? "replacement_rates" : "unknown",
        successor_basis: "provider_named",
        source: MAY_URL,
        ...(effort ? { notes: `Served at ${effort[1]} reasoning effort after the redirect.` } : {}),
      });
    }

    const nov = pages["imagine-image-quality-nov-2.md"];
    const novText = normalizeSpace(nov);
    const novMatch = /\*\*Effective (\w+ \d{1,2}, \d{4})\*\*, the `([^`]+)` model slug is retired/.exec(novText);
    const served = /requests to `([^`]+)` are served by `([^`]+)`/.exec(novText);
    if (!novMatch || !served || novMatch[2] !== served[1]) {
      throw new ParseMismatchError("xai", "the November retirement notice no longer matches");
    }
    const novEffective = parseDate(novMatch[1]);
    if (!novEffective || !isModelId(served[2])) throw new ParseMismatchError("xai", "the November retirement date or target is unreadable");
    out.push({
      type: "reroute",
      provider: "xai",
      route: "xai-api",
      model: served[1],
      to: served[2],
      effective: novEffective,
      date_precision: "exact",
      billing: /billed at the `[^`]+`/.test(novText) ? "replacement_rates" : "unknown",
      successor_basis: "provider_named",
      source: NOV_URL,
    });

    if (out.length < 5) throw new ParseMismatchError("xai", `expected at least 5 events, found ${out.length}`);

    // A new guide appears as a link in the index; warn rather than silently missing it.
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const m of pages["llms.txt"].matchAll(/developers\/migration\/([a-z0-9-]+)/g)) {
      if (!KNOWN_MIGRATIONS.has(m[1]) && !seen.has(m[1])) {
        seen.add(m[1]);
        warnings.push(`xai: migration guide "${m[1]}" is not parsed yet; add it to parsers/xai.ts.`);
      }
    }
    return { candidates: out, warnings };
  },
};
