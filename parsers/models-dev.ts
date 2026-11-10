import { daysBetween } from "../src/lib/text.ts";
import { vendorFor } from "../src/lib/vendor.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, RegistryModel, SourceDef } from "../src/types.ts";

const URL = "https://models.dev/api.json";
const NEW_MODEL_WINDOW_DAYS = 45;

/** models.dev provider key to route, and the fallback vendor for that route. */
export const ROUTES: Record<string, { route: string; vendor: string }> = {
  anthropic: { route: "anthropic-api", vendor: "anthropic" },
  google: { route: "google-ai-studio", vendor: "google" },
  openai: { route: "openai-api", vendor: "openai" },
  mistral: { route: "mistral-api", vendor: "mistral" },
  xai: { route: "xai-api", vendor: "xai" },
  cohere: { route: "cohere-api", vendor: "cohere" },
  groq: { route: "groq-api", vendor: "groq" },
  deepseek: { route: "deepseek-api", vendor: "deepseek" },
  togetherai: { route: "together-api", vendor: "together" },
  "amazon-bedrock": { route: "aws-bedrock", vendor: "amazon" },
  "google-vertex": { route: "google-vertex", vendor: "google" },
  "google-vertex-anthropic": { route: "google-vertex", vendor: "anthropic" },
};

interface DevModel {
  id: string;
  name?: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  release_date?: string;
  modalities?: { input?: string[]; output?: string[] };
  open_weights?: boolean;
  limit?: { context?: number; output?: number };
  status?: string;
  cost?: { input?: number; output?: number };
}

export const modelsDev: SourceDef = {
  id: "models-dev",
  kind: "secondary",
  files: { "api.json": URL },
  parse(pages, ctx) {
    let data: Record<string, { models?: Record<string, DevModel> }>;
    try {
      data = JSON.parse(pages["api.json"]);
    } catch {
      throw new ParseMismatchError("models-dev", "the response is not valid JSON");
    }
    const models: RegistryModel[] = [];
    const candidates: Candidate[] = [];
    for (const [providerKey, { route, vendor }] of Object.entries(ROUTES)) {
      const provider = data[providerKey];
      if (!provider?.models) throw new ParseMismatchError("models-dev", `provider "${providerKey}" is missing`);
      for (const m of Object.values(provider.models)) {
        const mapped = toModel(m, route, vendor);
        if (!mapped) continue;
        models.push(mapped);
        const age = m.release_date ? daysBetween(m.release_date, ctx.today) : Number.NaN;
        // Reseller listings would flag every re-host of an old model as new.
        if (age >= 0 && age <= NEW_MODEL_WINDOW_DAYS && isFirstParty(providerKey)) {
          candidates.push({
            type: "new_model",
            provider: mapped.provider,
            route,
            model: mapped.id,
            effective: m.release_date,
            date_precision: "estimated",
            source: URL,
          });
        }
      }
    }
    if (models.length < 300) throw new ParseMismatchError("models-dev", `expected at least 300 models, found ${models.length}`);
    return { candidates, models };
  },
};

function isFirstParty(key: string): boolean {
  return !["amazon-bedrock", "google-vertex", "google-vertex-anthropic", "groq", "togetherai"].includes(key);
}

const REGION_PREFIX = /^(us-gov|us|eu|au|apac|jp|in|ca|sa|global)\./;

function toModel(m: DevModel, route: string, fallbackVendor: string): RegistryModel | null {
  if (!m.id || typeof m.cost?.input !== "number" || typeof m.cost?.output !== "number") return null;
  if (!m.limit?.context) return null;
  const input = m.modalities?.input ?? [];
  const regionPrefix = route === "aws-bedrock" ? REGION_PREFIX.exec(m.id)?.[1] : undefined;
  return {
    id: m.id,
    provider: vendorFor(m.id, fallbackVendor),
    route,
    name: m.name ?? m.id,
    ...(m.family ? { family: m.family } : {}),
    ...(m.release_date ? { release_date: m.release_date } : {}),
    status: m.status === "deprecated" ? "deprecated" : "active",
    capabilities: {
      tools: !!m.tool_call,
      structured_output: !!m.structured_output,
      reasoning: !!m.reasoning,
      vision: input.includes("image"),
      audio: input.includes("audio"),
      pdf: input.includes("pdf"),
    },
    limit: { context: m.limit.context, output: m.limit.output ?? 0 },
    cost: { input: m.cost.input, output: m.cost.output },
    ...(typeof m.open_weights === "boolean" ? { open_weights: m.open_weights } : {}),
    ...(regionPrefix ? { region: [regionPrefix] } : {}),
    source: URL,
  };
}
