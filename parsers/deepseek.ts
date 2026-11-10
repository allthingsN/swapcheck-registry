import { mdSections, normalizeSpace, parseDate } from "../src/lib/text.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, SourceDef } from "../src/types.ts";

const UPDATES = "https://api-docs.deepseek.com/updates";
const PRICING = "https://api-docs.deepseek.com/quick_start/pricing";

const base = { provider: "deepseek", route: "deepseek-api" } as const;

export const deepseek: SourceDef = {
  id: "deepseek",
  kind: "primary",
  files: { "updates.md": `${UPDATES}.md`, "pricing.md": `${PRICING}.md` },
  parse(pages) {
    const sections = mdSections(pages["updates.md"]);
    const dated: Array<{ date: string; text: string }> = [];
    for (const s of sections) {
      const m = /^Date: (\d{4}-\d{2}-\d{2})/.exec(s.title);
      if (m) dated.push({ date: m[1], text: "" });
      else if (dated.length && s.level >= 3) dated[dated.length - 1].text += ` ${s.title}: ${s.body}`;
      if (m && dated.length) dated[dated.length - 1].text += ` ${s.body}`;
    }
    if (dated.length < 5) throw new ParseMismatchError("deepseek", `expected dated change log entries, found ${dated.length}`);

    const out = new Map<string, Candidate>();
    for (const { date, text } of dated) {
      const flat = normalizeSpace(text).replace(/`/g, "");
      for (const m of flat.matchAll(/has been upgraded to (DeepSeek-[\w-]+(?:\.[\w-]+)*)\..{0,160}?(?:use|set the model name to) (deepseek-[\w.-]+) to (?:access|use) the latest/g)) {
        out.set(`alias:${m[2]}:${date}`, aliasMove(m[2], m[1], date));
      }
      for (const m of flat.matchAll(/Both (deepseek-[\w.-]+) and (deepseek-[\w.-]+) have been upgraded to (DeepSeek-[\w-]+(?:\.[\w-]+)*)\./g)) {
        out.set(`alias:${m[1]}:${date}`, aliasMove(m[1], m[3], date));
        out.set(`alias:${m[2]}:${date}`, aliasMove(m[2], m[3], date));
      }
      const legacy = /legacy API model names,? (deepseek-[\w.-]+) and (deepseek-[\w.-]+),? will be discontinued.*?\((\d{4}-\d{2}-\d{2})\).*?deepseek-v4-flash/.exec(flat);
      if (legacy) {
        for (const model of [legacy[1], legacy[2]]) {
          out.set(`retire:${model}`, {
            ...base,
            type: "retirement",
            model,
            to: "deepseek-v4-flash",
            effective: legacy[3],
            date_precision: "exact",
            successor_basis: "provider_named",
            source: UPDATES,
            notes: `Announced ${date}: the legacy names pointed at the thinking and non-thinking modes of deepseek-v4-flash until discontinued.`,
          });
        }
      }
    }

    const pricing = normalizeSpace(pages["pricing.md"]).replace(/`/g, "");
    const note = /The legacy names (deepseek-[\w.-]+)(?: and (deepseek-[\w.-]+))? are still accepted, but the corresponding models have been retired, their requests are served by the (DeepSeek-[\w.-]+?) model and billed at the Flash price/.exec(pricing);
    if (!note) throw new ParseMismatchError("deepseek", "the legacy-name routing note on the pricing page no longer matches");
    const flash = dated.find((d) => /temporarily routed/.test(d.text.replace(/`/g, "")));
    for (const model of [note[1], note[2]].filter(Boolean) as string[]) {
      out.set(`reroute:${model}`, {
        ...base,
        type: "reroute",
        model,
        to: "deepseek-flash",
        ...(flash ? { effective: flash.date, date_precision: "exact" as const } : {}),
        billing: "replacement_rates",
        successor_basis: "provider_named",
        source: PRICING,
        notes: `Requests are served by ${note[3]}; the provider calls this temporary compatibility routing.`,
      });
    }
    if (out.size < 4) throw new ParseMismatchError("deepseek", `expected at least 4 events, found ${out.size}`);
    return { candidates: [...out.values()] };
  },
};

function aliasMove(model: string, to: string, date: string): Candidate {
  return {
    ...base,
    type: "alias_move",
    model,
    to,
    effective: parseDate(date) ?? undefined,
    date_precision: "exact",
    successor_basis: "provider_named",
    source: UPDATES,
    variant: date,
  };
}
