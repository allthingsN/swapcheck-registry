import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseDate, parseFootnotedIsoDate, mdTables, htmlTables } from "../src/lib/text.ts";
import {
  applyStatus,
  bedrockProfileEvents,
  carryForward,
  checkRemovals,
  consolidate,
  diffModels,
  eventId,
  mergeEvents,
  toPublic,
  validateSnapshot,
} from "../src/pipeline.ts";
import type { Observed } from "../src/pipeline.ts";
import { buildCalendar, buildFeed, serializeSnapshot, signBytes } from "../src/publish.ts";
import type { RegistryModel, RegistrySnapshot, StoredEvent } from "../src/types.ts";

const ROOT = join(import.meta.dirname, "..");
const TODAY = "2026-11-09";

function observed(overrides: Partial<Observed>): Observed {
  return {
    type: "retirement",
    provider: "acme",
    route: "acme-api",
    model: "m1",
    effective: "2027-01-01",
    date_precision: "exact",
    successor_basis: "none",
    source: "https://example.com/page",
    sourceId: "acme",
    kind: "primary",
    ...overrides,
  };
}

function stored(overrides: Partial<StoredEvent>): StoredEvent {
  return {
    id: "acme-api.retirement.m1",
    type: "retirement",
    provider: "acme",
    route: "acme-api",
    model: "m1",
    effective: "2027-01-01",
    date_precision: "exact",
    source: "https://example.com/page",
    confidence: "high",
    first_seen: "2026-10-01",
    last_verified: "2026-10-01",
    origin: "acme",
    ...overrides,
  };
}

function model(overrides: Partial<RegistryModel>): RegistryModel {
  return {
    id: "m1",
    provider: "acme",
    route: "acme-api",
    name: "M1",
    status: "active",
    capabilities: { tools: true, structured_output: false, reasoning: false, vision: false, audio: false, pdf: false },
    limit: { context: 1000, output: 100 },
    cost: { input: 1, output: 2 },
    source: "https://models.dev/api.json",
    ...overrides,
  };
}

function snapshot(events: StoredEvent[], models: RegistryModel[]): RegistrySnapshot {
  return { version: 1, generated_at: "2026-11-09T00:00:00.000Z", events: events.map(toPublic), models };
}

test("parseDate reads real formats and refuses qualified text", () => {
  assert.equal(parseDate("November 30, 2026"), "2026-11-30");
  assert.equal(parseDate("Apr 1, 2027"), "2027-04-01");
  assert.equal(parseDate("April 4th, 2026"), "2026-04-04");
  assert.equal(parseDate("09/21/26"), "2026-09-21");
  assert.equal(parseDate("2027-04-30"), "2027-04-30");
  assert.equal(parseDate("October 13, 2027 or later"), null);
  assert.equal(parseDate("To be announced"), null);
  assert.equal(parseDate("2026-13-40"), null);
});

test("parseFootnotedIsoDate strips Azure footnotes in both forms", () => {
  assert.equal(parseFootnotedIsoDate("2027-04-14^3^"), "2027-04-14");
  assert.equal(parseFootnotedIsoDate("2027-04-143"), "2027-04-14");
  assert.equal(parseFootnotedIsoDate("—"), null);
});

test("mdTables handles escaped pipes and htmlTables handles rowspan", () => {
  const [t] = mdTables("| A | B |\n| - | - |\n| `x` \\| `y` | z |\n");
  assert.deepEqual(t.rows[0], ["`x` | `y`", "z"]);
  const [h] = htmlTables('<h3>G</h3><table><tr><th>A</th><th>B</th></tr><tr><td rowspan="2">r</td><td>1</td></tr><tr><td>2</td></tr></table>');
  assert.deepEqual(h.rows, [["r", "1"], ["r", "2"]]);
  assert.equal(h.heading, "G");
});

test("event IDs are stable and collision-resistant", () => {
  const a = eventId(observed({ route: "aws-bedrock", model: "anthropic.claude-3-v1:0" }));
  assert.equal(a, "aws-bedrock.retirement.anthropic.claude-3-v1..0");
  assert.notEqual(eventId(observed({ model: "qwen/x" })), eventId(observed({ model: "qwen-x" })));
});

test("confidence: a provider page is high; two agreeing secondaries are medium; one is low", () => {
  const { events } = consolidate(
    [
      observed({}),
      observed({ model: "m2", kind: "secondary", sourceId: "litellm", source: "https://x.test/a" }),
      observed({ model: "m2", kind: "secondary", sourceId: "deprecations-info", source: "https://x.test/b" }),
      observed({ model: "m3", kind: "secondary", sourceId: "litellm", source: "https://x.test/a" }),
    ],
    TODAY,
  );
  const by = Object.fromEntries(events.map((e) => [e.candidate.model, e.confidence]));
  assert.deepEqual(by, { m1: "high", m2: "medium", m3: "low" });
});

test("confidence: secondaries that disagree or an inferred successor stay low", () => {
  const { events } = consolidate(
    [
      observed({ model: "m2", kind: "secondary", sourceId: "litellm" }),
      observed({ model: "m2", kind: "secondary", sourceId: "deprecations-info", effective: "2027-06-01" }),
      observed({ model: "m3", kind: "secondary", sourceId: "litellm", to: "m4", successor_basis: "inferred" }),
      observed({ model: "m3", kind: "secondary", sourceId: "deprecations-info" }),
    ],
    TODAY,
  );
  for (const e of events) assert.equal(e.confidence, "low", e.candidate.model);
  const inferred = events.find((e) => e.candidate.model === "m3")!;
  assert.equal(inferred.candidate.to, "m4");
  assert.equal(inferred.candidate.successor_basis, "inferred");
});

test("a primary event ignores secondary successors, and disagreements are reported", () => {
  const { events, crossCheck } = consolidate(
    [observed({ to: undefined }), observed({ kind: "secondary", sourceId: "litellm", effective: "2027-02-02", to: "m9", successor_basis: "inferred" })],
    TODAY,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].candidate.to, undefined);
  assert.equal(events[0].confidence, "high");
  assert.deepEqual(crossCheck, [{ route: "acme-api", model: "m1", primary_date: "2027-01-01", secondary_date: "2027-02-02", secondary: "litellm" }]);
});

test("a single secondary date in the past is not published", () => {
  const { events } = consolidate([observed({ kind: "secondary", sourceId: "litellm", effective: "2026-01-01" })], TODAY);
  assert.equal(events.length, 0);
});

test("the same model on another platform is a separate event", () => {
  const { events } = consolidate([observed({}), observed({ route: "aws-bedrock", sourceId: "bedrock" })], TODAY);
  assert.equal(new Set(events.map((e) => e.id)).size, 2);
});

test("an amended event keeps history and first_seen", () => {
  const existing = [stored({})];
  const current = consolidate([observed({ effective: "2027-03-03" })], TODAY).events;
  const { events, amended } = mergeEvents(existing, current, new Set(["acme"]), TODAY);
  assert.deepEqual(amended, ["acme-api.retirement.m1"]);
  assert.equal(events[0].effective, "2027-03-03");
  assert.equal(events[0].first_seen, "2026-10-01");
  assert.deepEqual(events[0].history, [{ amended_at: TODAY, previous: { effective: "2027-01-01", successor_basis: null } }]);
});

test("a stored event survives when its source stops listing it or fails", () => {
  const existing = [stored({})];
  const dropped = mergeEvents(existing, [], new Set(["acme"]), TODAY);
  assert.equal(dropped.events.length, 1);
  assert.equal(dropped.events[0].not_listed_since, TODAY);
  const failed = mergeEvents(existing, [], new Set(), TODAY);
  assert.equal(failed.events.length, 1);
  assert.equal(failed.events[0].not_listed_since, undefined);
});

test("re-verifying with no change is not an amendment", () => {
  const { amended, added, events } = mergeEvents([stored({ last_verified: "2026-10-01", successor_basis: "none" })], consolidate([observed({})], TODAY).events, new Set(["acme"]), TODAY);
  assert.deepEqual([amended, added], [[], []]);
  assert.equal(events[0].last_verified, TODAY);
});

test("a run removing over 20% of models or events is refused", () => {
  const events = Array.from({ length: 10 }, (_, i) => stored({ id: `e${i}`, model: `m${i}` }));
  const models = Array.from({ length: 10 }, (_, i) => model({ id: `m${i}` }));
  const before = snapshot(events, models);
  assert.equal(checkRemovals(before, snapshot(events.slice(0, 8), models)).ok, true);
  assert.equal(checkRemovals(before, snapshot(events.slice(0, 7), models)).ok, false);
  assert.equal(checkRemovals(before, snapshot(events, models.slice(0, 7))).ok, false);
  assert.match(checkRemovals(before, snapshot(events, models.slice(0, 7))).message!, /Refusing to publish/);
  assert.equal(checkRemovals(null, snapshot(events, models)).ok, true);
});

test("models from a failed source are carried forward", () => {
  const prev = snapshot([], [model({ id: "kept", source: "https://failed.test/a" }), model({ id: "gone", source: "https://ok.test/a" })]);
  const out = carryForward(prev, [model({ id: "fresh", source: "https://ok.test/a" })], new Set(["https://failed.test/a"]));
  assert.deepEqual(out.map((m) => m.id).sort(), ["fresh", "kept"]);
});

test("status: only an exact past date retires a model; a passed floor does not", () => {
  const events = [
    stored({ id: "a", model: "past", effective: "2026-01-01" }),
    stored({ id: "b", model: "floor", effective: "2026-01-01", date_precision: "earliest_possible" }),
    stored({ id: "c", model: "soon", effective: "2027-01-01" }),
  ];
  const out = applyStatus([model({ id: "past" }), model({ id: "floor" }), model({ id: "soon" }), model({ id: "ok" })], events, TODAY);
  assert.deepEqual(out.map((m) => m.status), ["retired", "deprecated", "deprecated", "active"]);
});

test("Bedrock inference profiles inherit dates at low confidence", () => {
  const { events } = consolidate([observed({ route: "aws-bedrock", model: "anthropic.x-v1:0", sourceId: "bedrock" })], TODAY);
  const profiles = bedrockProfileEvents(events, ["us.anthropic.x-v1:0", "global.anthropic.x-v1:0", "anthropic.x-v1:0", "us.other"]);
  assert.deepEqual(profiles.map((p) => p.candidate.model).sort(), ["global.anthropic.x-v1:0", "us.anthropic.x-v1:0"]);
  assert.ok(profiles.every((p) => p.confidence === "low" && p.candidate.notes?.includes("inferred")));
});

test("model diffs produce price and capability events", () => {
  const prev = snapshot([], [model({})]);
  const { candidates, changed } = diffModels(prev, [model({ cost: { input: 2, output: 2 }, capabilities: { ...model({}).capabilities, vision: true } })], TODAY);
  assert.equal(changed, 1);
  assert.deepEqual(candidates.map((c) => c.type).sort(), ["capability_change", "price_change"]);
  assert.match(candidates.find((c) => c.type === "price_change")!.notes!, /Input 1 to 2/);
});

test("validateSnapshot rejects contract violations", () => {
  const bad = snapshot([stored({ source: "not a url", effective: "2027-01-01", date_precision: undefined })], [model({ limit: { context: 0, output: 0 } })]);
  const problems = validateSnapshot(bad);
  assert.ok(problems.some((p) => p.includes("source")));
  assert.ok(problems.some((p) => p.includes("precision")));
  assert.ok(problems.some((p) => p.includes("context")));
  assert.deepEqual(validateSnapshot(snapshot([stored({})], [model({})])), []);
});

test("the snapshot signature verifies over the exact bytes", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const bytes = Buffer.from(serializeSnapshot(snapshot([stored({})], [model({})])));
  const sig = signBytes(bytes, pem);
  assert.ok(verify(null, bytes, publicKey, Buffer.from(sig, "base64")));
  const tampered = Buffer.from(bytes);
  tampered[10] ^= 1;
  assert.ok(!verify(null, tampered, publicKey, Buffer.from(sig, "base64")));
});

test("the RSS feed escapes web-sourced text and skips new-model noise", () => {
  const xml = buildFeed(
    [
      toPublic(stored({ id: "a", model: "<script>&x", to: 'y"z' })),
      toPublic(stored({ id: "b", type: "new_model", model: "fresh" })),
    ],
    "2026-11-09T00:00:00.000Z",
    "https://example.com/",
  );
  assert.ok(xml.startsWith('<?xml version="1.0"'));
  assert.ok(!xml.includes("<script>"));
  assert.ok(xml.includes("&lt;script&gt;&amp;x"));
  assert.ok(!xml.includes("fresh"));
});

test("calendar.json lists future dated events only, soonest first", () => {
  const cal = JSON.parse(
    buildCalendar(
      [toPublic(stored({ id: "l", effective: "2027-05-01" })), toPublic(stored({ id: "s", effective: "2026-12-01" })), toPublic(stored({ id: "p", effective: "2026-01-01" }))],
      TODAY,
      "2026-11-09T00:00:00.000Z",
    ),
  );
  assert.deepEqual(cal.entries.map((e: { event_id: string }) => e.event_id), ["s", "l"]);
});

test("a full offline run over the recorded fixtures builds a valid snapshot", () => {
  const out = execFileSync(process.execPath, ["--no-warnings", join(ROOT, "scripts/update.ts"), "--offline", "--dry-run", "--today", TODAY], { encoding: "utf8", env: { ...process.env, REGISTRY_SIGNING_KEY_PEM: "" } });
  assert.match(out, /source failures: 0/);
  const count = Number(/(\d+) events/.exec(out)![1]);
  assert.ok(count > 500, `expected a populated registry, got ${count}`);
});

test("no model writes registry facts: pipeline code never calls an LLM API", () => {
  const files = ["parsers", "scripts", "src", "src/lib"].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith(".ts"))
      .map((f) => join(ROOT, dir, f.name)),
  );
  assert.ok(files.length > 20);
  const forbidden = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis|\/v1\/messages|\/chat\/completions|@anthropic-ai\/sdk|from "openai"/;
  for (const file of files) assert.equal(forbidden.test(readFileSync(file, "utf8")), false, file);
});

test("workflows pin actions by full SHA, use least privilege and avoid pull_request_target", () => {
  const dir = join(ROOT, ".github/workflows");
  const files = readdirSync(dir);
  assert.deepEqual(files.sort(), ["pages.yml", "update.yml"]);
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    assert.equal(text.includes("pull_request_target"), false, file);
    assert.match(text, /^permissions:\n {2}contents: read/m, file);
    for (const use of text.matchAll(/uses:\s*(\S+)/g)) assert.match(use[1], /@[0-9a-f]{40}$/, `${file}: ${use[1]}`);
  }
});
