import { isModelId, parseDate } from "../src/lib/text.ts";
import { vendorFor } from "../src/lib/vendor.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, SourceDef } from "../src/types.ts";

const URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Longest prefix first, so `vertex_ai-*` wins over a shorter match. */
const ROUTES: Array<[RegExp, string, string]> = [
  [/^vertex_ai-/, "google-vertex", "google"],
  [/^gemini$/, "google-ai-studio", "google"],
  [/^bedrock(_converse)?$/, "aws-bedrock", "amazon"],
  [/^azure$/, "azure-foundry", "microsoft"],
  [/^openai$/, "openai-api", "openai"],
  [/^anthropic$/, "anthropic-api", "anthropic"],
  [/^mistral$/, "mistral-api", "mistral"],
  [/^xai$/, "xai-api", "xai"],
  [/^cohere(_chat)?$/, "cohere-api", "cohere"],
  [/^groq$/, "groq-api", "groq"],
  [/^deepseek$/, "deepseek-api", "deepseek"],
  [/^together_ai$/, "together-api", "together"],
];

interface LiteLlmEntry {
  litellm_provider?: string;
  mode?: string;
  deprecation_date?: string;
  successor_model?: string;
}

const STRIP_PREFIX = /^(gemini|vertex_ai|azure|openai|anthropic|bedrock(?:_converse)?|mistral|xai|cohere(?:_chat)?|groq|deepseek|together_ai)\//;

export const litellm: SourceDef = {
  id: "litellm",
  kind: "secondary",
  files: { "model_prices.json": URL },
  parse(pages) {
    let data: Record<string, LiteLlmEntry>;
    try {
      data = JSON.parse(pages["model_prices.json"]);
    } catch {
      throw new ParseMismatchError("litellm", "the response is not valid JSON");
    }
    if (typeof data !== "object" || Object.keys(data).length < 100) {
      throw new ParseMismatchError("litellm", "expected a map of model keys");
    }
    const out = new Map<string, Candidate>();
    for (const [key, entry] of Object.entries(data)) {
      if (!entry || typeof entry !== "object" || !entry.deprecation_date) continue;
      const provider = entry.litellm_provider ?? "";
      const route = ROUTES.find(([re]) => re.test(provider));
      if (!route) continue;
      const effective = parseDate(entry.deprecation_date);
      const model = key.replace(STRIP_PREFIX, "");
      // Region prefixes, sizes and nested routes are LiteLLM path variants, not callable model IDs.
      const slashes = (model.match(/\//g) ?? []).length;
      const allowedSlashes = route[1] === "groq-api" || route[1] === "together-api" ? 1 : 0;
      if (!effective || !isModelId(model) || slashes > allowedSlashes) continue;
      // Azure retires by version; LiteLLM's unversioned Azure keys cannot be tied to one.
      if (route[1] === "azure-foundry" && !/\d{4}-\d{2}-\d{2}$/.test(model)) continue;
      const to = entry.successor_model && isModelId(entry.successor_model) ? entry.successor_model.replace(STRIP_PREFIX, "") : undefined;
      out.set(`${route[1]}:${model}`, {
        type: "retirement",
        provider: vendorFor(model, route[2]),
        route: route[1],
        model,
        ...(to ? { to } : {}),
        effective,
        date_precision: "estimated",
        successor_basis: to ? "inferred" : "none",
        source: URL,
      });
    }
    if (out.size < 50) throw new ParseMismatchError("litellm", `expected at least 50 dated entries, found ${out.size}`);
    return { candidates: [...out.values()] };
  },
};
