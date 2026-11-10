import { isModelId, parseDate } from "../src/lib/text.ts";
import { vendorFor } from "../src/lib/vendor.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, SourceDef } from "../src/types.ts";

const URL = "https://deprecations.info/v1/feed.json";

const ROUTES: Record<string, { route: string; vendor: string }> = {
  OpenAI: { route: "openai-api", vendor: "openai" },
  Anthropic: { route: "anthropic-api", vendor: "anthropic" },
  Groq: { route: "groq-api", vendor: "groq" },
  Cohere: { route: "cohere-api", vendor: "cohere" },
  xAI: { route: "xai-api", vendor: "xai" },
  "Google Vertex": { route: "google-vertex", vendor: "google" },
  // Azure rows here have no version, so they cannot be matched to a deployment; left out on purpose.
};

interface FeedItem {
  url?: string;
  _deprecation?: {
    provider?: string;
    model_id?: string;
    shutdown_date?: string;
    replacement_models?: string[] | null;
  };
}

export const deprecationsInfo: SourceDef = {
  id: "deprecations-info",
  kind: "secondary",
  files: { "feed.json": URL },
  parse(pages) {
    let items: FeedItem[];
    try {
      items = JSON.parse(pages["feed.json"]).items;
    } catch {
      throw new ParseMismatchError("deprecations-info", "the response is not valid JSON");
    }
    if (!Array.isArray(items) || items.length < 50) throw new ParseMismatchError("deprecations-info", "expected an items array");

    const out = new Map<string, Candidate>();
    for (const item of items) {
      const d = item._deprecation;
      const route = d?.provider ? ROUTES[d.provider] : undefined;
      if (!d || !route || !d.model_id || !isModelId(d.model_id)) continue;
      const effective = d.shutdown_date ? parseDate(d.shutdown_date) : null;
      if (!effective) continue;
      const [named] = (d.replacement_models ?? []).filter(isModelId);
      out.set(`${route.route}:${d.model_id}`, {
        type: "retirement",
        provider: vendorFor(d.model_id, route.vendor),
        route: route.route,
        model: d.model_id,
        ...(named ? { to: named } : {}),
        effective,
        date_precision: "estimated",
        successor_basis: named ? "inferred" : "none",
        source: URL,
      });
    }
    return { candidates: [...out.values()] };
  },
};
