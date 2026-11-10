import { parseDate } from "../src/lib/text.ts";
import { vendorFor } from "../src/lib/vendor.ts";
import { ParseMismatchError } from "../src/types.ts";
import type { Candidate, RegistryModel, SourceDef } from "../src/types.ts";

const URL = "https://openrouter.ai/api/v1/models";

interface OrModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
  top_provider?: { context_length?: number; max_completion_tokens?: number | null };
  supported_parameters?: string[];
  expiration_date?: string | null;
}

export const openrouter: SourceDef = {
  id: "openrouter",
  kind: "primary",
  files: { "models.json": URL },
  parse(pages) {
    let data: OrModel[];
    try {
      data = JSON.parse(pages["models.json"]).data;
    } catch {
      throw new ParseMismatchError("openrouter", "the response is not valid JSON");
    }
    if (!Array.isArray(data) || data.length < 100) throw new ParseMismatchError("openrouter", "expected a data array of models");

    const models: RegistryModel[] = [];
    const candidates: Candidate[] = [];
    for (const m of data) {
      if (!m.id || /:(free|extended|nitro|floor)$/.test(m.id) || m.id.startsWith("openrouter/")) continue;
      const input = Number(m.pricing?.prompt);
      const output = Number(m.pricing?.completion);
      if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
      const params = m.supported_parameters ?? [];
      const inputKinds = m.architecture?.input_modalities ?? [];
      const provider = vendorFor(m.id, m.id.split("/")[0]);
      const context = m.top_provider?.context_length ?? m.context_length ?? 0;
      if (!context) continue;
      models.push({
        id: m.id,
        provider,
        route: "openrouter",
        name: m.name ?? m.id,
        ...(typeof m.created === "number" ? { release_date: new Date(m.created * 1000).toISOString().slice(0, 10) } : {}),
        status: "active",
        capabilities: {
          tools: params.includes("tools"),
          structured_output: params.includes("response_format") || params.includes("structured_outputs"),
          reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
          vision: inputKinds.includes("image"),
          audio: inputKinds.includes("audio"),
          pdf: inputKinds.includes("file"),
        },
        limit: { context, output: m.top_provider?.max_completion_tokens ?? 0 },
        cost: { input: roundUsd(input * 1e6), output: roundUsd(output * 1e6) },
        source: URL,
      });
      const expires = m.expiration_date ? parseDate(m.expiration_date) : null;
      if (expires) {
        // OpenRouter's own API speaks for its own route, which makes this first-party for this route.
        candidates.push({
          type: "retirement",
          provider,
          route: "openrouter",
          model: m.id,
          effective: expires,
          date_precision: "exact",
          successor_basis: "none",
          source: URL,
        });
      }
    }
    if (models.length < 100) throw new ParseMismatchError("openrouter", `expected at least 100 usable models, found ${models.length}`);
    return { candidates, models };
  },
};

function roundUsd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
