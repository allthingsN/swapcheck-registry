import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SOURCES } from "../parsers/index.ts";
import type { Candidate, ParseResult, SourceDef } from "../src/types.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const TODAY = "2026-11-09";

function pagesFor(source: SourceDef): Record<string, string> {
  const pages: Record<string, string> = {};
  for (const file of Object.keys(source.files)) pages[file] = readFileSync(join(FIXTURES, source.id, file), "utf8");
  return pages;
}

function run(id: string): ParseResult {
  const source = SOURCES.find((s) => s.id === id)!;
  return source.parse(pagesFor(source), { today: TODAY });
}

function find(result: ParseResult, type: Candidate["type"], model: string): Candidate {
  const found = result.candidates.find((c) => c.type === type && c.model === model);
  assert.ok(found, `missing ${type} for ${model}`);
  return found;
}

test("every parser matches its recorded page, and only the expected sources produce models", () => {
  assert.equal(SOURCES.length, 16);
  for (const source of SOURCES) {
    const r = source.parse(pagesFor(source), { today: TODAY });
    assert.ok(r.candidates.length > 0, `${source.id} produced no events`);
    for (const c of r.candidates) {
      assert.ok(c.model && c.route && c.provider && c.source.startsWith("https://"), `${source.id}: incomplete ${JSON.stringify(c)}`);
    }
  }
});

test("a page that no longer matches raises a parse mismatch rather than an empty result", () => {
  for (const source of SOURCES) {
    const pages = Object.fromEntries(Object.keys(source.files).map((f) => [f, "<html><body>maintenance</body></html>"]));
    assert.throws(() => source.parse(pages, { today: TODAY }), { name: "ParseMismatchError" }, source.id);
  }
});

test("parsers are deterministic", () => {
  for (const source of SOURCES) {
    assert.deepEqual(source.parse(pagesFor(source), { today: TODAY }), source.parse(pagesFor(source), { today: TODAY }), source.id);
  }
});

test("Anthropic: Sonnet 4.5 retires 2026-11-30 to Sonnet 5.5, exact", () => {
  const e = find(run("anthropic"), "retirement", "claude-sonnet-4-5-20250929");
  assert.equal(e.effective, "2026-11-30");
  assert.equal(e.to, "claude-sonnet-5-5");
  assert.equal(e.date_precision, "exact");
  assert.equal(e.successor_basis, "provider_named");
});

test("Anthropic: API version 2026-10-21 removes temperature, top_p and top_k for live models only", () => {
  const r = run("anthropic");
  const e = find(r, "parameter_change", "claude-opus-5-5");
  assert.equal(e.effective, "2026-10-21");
  assert.deepEqual(e.params, ["temperature", "top_p", "top_k"]);
  assert.ok(!r.candidates.some((c) => c.type === "parameter_change" && c.model === "claude-3-haiku-20240307"), "retired model should not get the event");
});

test("Anthropic: 'Not sooner than' on an active model is not a retirement; a TBA deprecation has no date", () => {
  const r = run("anthropic");
  assert.ok(!r.candidates.some((c) => c.type === "retirement" && c.model === "claude-opus-5-5"));
  const tba = find(r, "retirement", "claude-mythos-preview");
  assert.equal(tba.effective, undefined);
  assert.equal(tba.date_precision, undefined);
});

test("Gemini: the two 2.5 re-routes land on 2026-12-01 at replacement rates", () => {
  const r = run("gemini");
  const pro = find(r, "reroute", "gemini-2.5-pro");
  assert.equal(pro.to, "gemini-3.8-flash");
  assert.equal(pro.effective, "2026-12-01");
  assert.equal(pro.billing, "replacement_rates");
  assert.equal(pro.date_precision, "exact");
  const flash = find(r, "reroute", "gemini-2.5-flash");
  assert.equal(flash.to, "gemini-3.5-flash-lite");
  assert.equal(flash.billing, "replacement_rates");
});

test("Gemini: table-only shutdown dates are floors; shut-down rows are exact", () => {
  const r = run("gemini");
  assert.equal(find(r, "retirement", "gemini-3.1-flash-lite").date_precision, "earliest_possible");
  assert.equal(find(r, "retirement", "gemini-2.0-flash").date_precision, "exact");
  assert.ok(!r.candidates.some((c) => c.model === "antigravity-preview-05-2026"), "managed agents are not models");
});

test("Gemini: a re-route with no date keeps no date", () => {
  const e = find(run("gemini"), "reroute", "gemini-3.5-flash");
  assert.equal(e.to, "gemini-3.6-flash");
  assert.equal(e.effective, undefined);
});

test("OpenAI: GPT-5 aliases and snapshots retire together; a descriptive replacement is not a model", () => {
  const r = run("openai");
  for (const model of ["gpt-5", "gpt-5-2025-08-07"]) assert.equal(find(r, "retirement", model).effective, "2026-12-11");
  assert.equal(find(r, "retirement", "gpt-5").to, "gpt-5.6-sol");
  const cyber = find(r, "retirement", "gpt-5.5-cyber-preview");
  assert.equal(cyber.to, undefined);
  assert.equal(cyber.successor_basis, "none");
  assert.ok(!r.candidates.some((c) => c.model.startsWith("/") || c.model.startsWith("v1/")), "endpoints are not models");
});

test("Bedrock: a separate schedule from Anthropic's, with region dates and extended access", () => {
  const r = run("bedrock");
  const sonnet = find(r, "retirement", "anthropic.claude-sonnet-4-5-20250929-v1:0");
  assert.equal(sonnet.route, "aws-bedrock");
  assert.equal(sonnet.provider, "anthropic");
  assert.equal(sonnet.effective, "2027-04-08");
  assert.equal(find(r, "price_change", "anthropic.claude-sonnet-4-5-20250929-v1:0").effective, "2027-01-08");
  const haiku = find(r, "retirement", "anthropic.claude-3-haiku-20240307-v1:0");
  assert.equal(haiku.effective, "2026-11-13", "earliest region date");
  assert.match(haiku.notes!, /differ by region/);
  assert.deepEqual(haiku.region_schedule?.map((row) => row.effective), ["2026-11-13", "2026-11-13", "2026-11-27"]);
  assert.deepEqual(haiku.region_schedule?.[2]?.regions, ["ca-central-1"]);
  const sonnet37 = find(r, "retirement", "anthropic.claude-3-7-sonnet-20250219-v1:0");
  assert.deepEqual(sonnet37.region_schedule, [{ regions: ["ap-south-1", "eu-west-2"], effective: "2026-11-13" }], "a single-row item keeps its regions");
  assert.ok(sonnet.region_schedule?.some((row) => row.regions.includes("us-west-2")));
  assert.ok(r.candidates.some((c) => c.model === "deepseek.v3.1"), "both IDs in a cell are kept");
  assert.ok(!r.candidates.some((c) => /[()\s]/.test(c.model)));
});

test("Vertex: separate from AI Studio, and a date in the 12-month group is a floor", () => {
  const r = run("vertex");
  const pro = find(r, "retirement", "gemini-2.5-pro");
  assert.equal(pro.route, "google-vertex");
  assert.equal(pro.effective, "2026-10-20");
  assert.equal(pro.date_precision, "earliest_possible");
  assert.equal(find(r, "retirement", "gemini-3.6-flash").date_precision, "exact");
  assert.ok(!r.candidates.some((c) => c.model === "gemini-4-argon"), "'October 13, 2027 or later' is a floor, not a retirement");
});

test("Azure: footnoted dates are read and each date is a separate version", () => {
  const r = run("azure");
  const e = find(r, "retirement", "gpt-4o-2024-05-13");
  assert.equal(e.effective, "2027-01-14");
  assert.equal(e.to, "gpt-5.1");
  assert.equal(e.date_precision, "exact");
  assert.equal(e.provider, "openai");
  assert.equal(r.warnings?.length ?? 0, 0);
});

test("Mistral: replacement links resolve to API names", () => {
  const e = find(run("mistral"), "retirement", "mistral-large-2512");
  assert.equal(e.effective, "2027-04-30");
  assert.equal(e.to, "mistral-large-4");
});

test("xAI: May redirects are billed at the replacement price", () => {
  const r = run("xai");
  const e = find(r, "reroute", "grok-3");
  assert.equal(e.to, "grok-4.3");
  assert.equal(e.effective, "2026-05-15");
  assert.equal(e.billing, "replacement_rates");
  assert.equal(find(r, "reroute", "grok-imagine-image-quality").effective, "2026-11-02");
});

test("Cohere: the prose effective date is used and non-model bullets are ignored", () => {
  const r = run("cohere");
  assert.equal(find(r, "retirement", "c4ai-aya-expanse-8b").effective, "2026-04-04");
  assert.equal(find(r, "retirement", "command-r-03-2024").effective, "2025-09-15");
  assert.ok(!r.candidates.some((c) => c.model === "summarize"));
});

test("Groq: two-digit-year dates and multiple named replacements", () => {
  const r = run("groq");
  const e = find(r, "retirement", "llama-3.3-70b-versatile");
  assert.equal(e.effective, "2026-08-16");
  assert.equal(e.to, "openai/gpt-oss-120b");
  assert.match(e.notes!, /qwen\/qwen3\.6-27b/);
});

test("DeepSeek: alias moves, legacy discontinuation and rerouted names", () => {
  const r = run("deepseek");
  const alias = find(r, "alias_move", "deepseek-flash");
  assert.equal(alias.to, "DeepSeek-V4.1-Flash-1017");
  assert.equal(alias.effective, "2026-10-17");
  assert.equal(find(r, "retirement", "deepseek-chat").effective, "2026-07-24");
  const reroute = find(r, "reroute", "deepseek-v4-flash");
  assert.equal(reroute.billing, "replacement_rates");
  assert.equal(reroute.effective, "2026-09-10");
});

test("Together: redirects and a history date that overrides the planned one", () => {
  const r = run("together");
  assert.equal(find(r, "reroute", "DeepSeek-V3").to, "DeepSeek-V3.1");
  const e = find(r, "retirement", "openai/gpt-oss-20b");
  assert.equal(e.effective, "2026-09-15");
  assert.equal(e.notes, "Removed from serverless inference.");
});

test("models.dev: capabilities, limits and prices map from the real shape", () => {
  const { models } = run("models-dev");
  const sonnet = models!.find((m) => m.route === "anthropic-api" && m.id === "claude-sonnet-4-5-20250929")!;
  assert.deepEqual(sonnet.capabilities, { tools: true, structured_output: true, reasoning: true, vision: true, audio: false, pdf: true });
  assert.deepEqual(sonnet.limit, { context: 200000, output: 64000 });
  assert.deepEqual(sonnet.cost, { input: 3, output: 15 });
  assert.equal(models!.find((m) => m.id.startsWith("anthropic.claude-sonnet-4-5"))!.provider, "anthropic");
  const groq = models!.find((m) => m.route === "groq-api" && /gpt-oss/.test(m.id));
  assert.equal(groq?.provider, "openai");
});

test("OpenRouter: free variants are excluded and supported_parameters drive capabilities", () => {
  const { models, candidates } = run("openrouter");
  assert.ok(!models!.some((m) => m.id.endsWith(":free")));
  assert.ok(models!.every((m) => m.route === "openrouter" && m.cost.input >= 0 && m.limit.context > 0));
  assert.ok(candidates.every((c) => c.type === "retirement" && c.route === "openrouter"));
});

test("LiteLLM: successors are inferred, region paths and unversioned Azure keys are excluded", () => {
  const r = run("litellm");
  assert.ok(r.candidates.every((c) => c.successor_basis === "inferred" || c.successor_basis === "none"));
  assert.ok(!r.candidates.some((c) => c.route === "aws-bedrock" && c.model.includes("/")));
  assert.ok(!r.candidates.some((c) => c.route === "azure-foundry" && !/\d{4}-\d{2}-\d{2}$/.test(c.model)));
  assert.equal(find(r, "retirement", "gemini-2.5-pro").route, "google-vertex");
});

test("deprecations.info: maps known providers and skips Azure rows it cannot version", () => {
  const r = run("deprecations-info");
  assert.ok(r.candidates.length > 100);
  assert.ok(!r.candidates.some((c) => c.route === "azure-foundry"));
});
