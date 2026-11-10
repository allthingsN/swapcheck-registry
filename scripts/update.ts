/**
 * Fetch, parse, diff, write events, build and sign the snapshot.
 *   node scripts/update.ts              live fetch
 *   node scripts/update.ts --offline    parse the recorded fixtures
 *   --dry-run                           report only; write nothing
 *   --today YYYY-MM-DD                  override the run date
 * Signs only when REGISTRY_SIGNING_KEY_PEM is set.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SOURCES } from "../parsers/index.ts";
import {
  applyStatus,
  bedrockProfileEvents,
  carryForward,
  checkRemovals,
  consolidate,
  diffModels,
  eventId,
  mergeEvents,
  modelKey,
  toPublic,
  validateSnapshot,
} from "../src/pipeline.ts";
import type { Consolidated, Observed } from "../src/pipeline.ts";
import { fetchText } from "../src/lib/fetch.ts";
import { buildCalendar, buildFeed, serializeSnapshot, signBytes } from "../src/publish.ts";
import type { Candidate, RegistryModel, RegistrySnapshot, SourceDef, StoredEvent } from "../src/types.ts";

const ROOT = join(import.meta.dirname, "..");
const SITE_URL = "https://allthingsn.github.io/swapcheck-registry/";
/** Clients warn at 7 days, so even a quiet registry republishes within this many days. */
const REFRESH_AFTER_DAYS = 3;

interface Options {
  offline: boolean;
  dryRun: boolean;
  today: string;
  now: string;
}

function parseArgs(argv: string[]): Options {
  const now = new Date().toISOString();
  const todayIndex = argv.indexOf("--today");
  return {
    offline: argv.includes("--offline"),
    dryRun: argv.includes("--dry-run"),
    today: todayIndex >= 0 ? argv[todayIndex + 1] : now.slice(0, 10),
    now,
  };
}

interface SourceOutcome {
  id: string;
  kind: string;
  ok: boolean;
  events: number;
  models: number;
  warnings: string[];
  error?: string;
  urls: string[];
}

async function runSource(source: SourceDef, opts: Options) {
  const pages: Record<string, string> = {};
  const urls = Object.values(source.files);
  try {
    for (const [file, url] of Object.entries(source.files)) {
      pages[file] = opts.offline ? readFileSync(join(ROOT, "fixtures", source.id, file), "utf8") : await fetchText(url, file);
    }
    const result = source.parse(pages, { today: opts.today });
    const outcome: SourceOutcome = { id: source.id, kind: source.kind, ok: true, events: result.candidates.length, models: result.models?.length ?? 0, warnings: result.warnings ?? [], urls };
    return { outcome, candidates: result.candidates, models: result.models ?? [] };
  } catch (err) {
    const outcome: SourceOutcome = { id: source.id, kind: source.kind, ok: false, events: 0, models: 0, warnings: [], error: err instanceof Error ? err.message : String(err), urls };
    return { outcome, candidates: [] as Candidate[], models: [] as RegistryModel[] };
  }
}

function readEvents(): StoredEvent[] {
  const out: StoredEvent[] = [];
  const root = join(ROOT, "events");
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(root, dir.name))) {
      if (file.endsWith(".json")) out.push(JSON.parse(readFileSync(join(root, dir.name, file), "utf8")));
    }
  }
  return out;
}

function readSnapshot(): RegistrySnapshot | null {
  try {
    return JSON.parse(readFileSync(join(ROOT, "dist/snapshot.json"), "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function daysSince(iso: string | undefined, today: string): number {
  if (!iso) return Infinity;
  return (Date.parse(`${today}T00:00:00Z`) - Date.parse(iso)) / 86_400_000;
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.today)) fail("--today must be a date in YYYY-MM-DD form.", 2);

  const previous = readSnapshot();
  const runs = await Promise.all(SOURCES.map((s) => runSource(s, opts)));
  const outcomes = runs.map((r) => r.outcome);
  const healthy = new Set(outcomes.filter((o) => o.ok).map((o) => o.id));
  const failedUrls = new Set(outcomes.filter((o) => !o.ok).flatMap((o) => o.urls));

  const observed: Observed[] = runs.flatMap((r) =>
    r.candidates.map((c) => ({ ...c, sourceId: r.outcome.id, kind: SOURCES.find((s) => s.id === r.outcome.id)!.kind })),
  );

  const parsedModels = dedupeModels(runs.flatMap((r) => r.models));
  const models = carryForward(previous, parsedModels, failedUrls);
  const modelIds = models.filter((m) => m.route === "aws-bedrock").map((m) => m.id);

  const { events: consolidated, crossCheck } = consolidate(observed, opts.today);
  const profiles = bedrockProfileEvents(consolidated, modelIds);
  const diff = diffModels(previous, models, opts.today);
  const diffEvents: Consolidated[] = diff.candidates.map((c) => ({
    candidate: c,
    id: eventId(c),
    confidence: c.route === "openrouter" ? "high" : "low",
    origin: c.route === "openrouter" ? "openrouter" : "models-dev",
  }));

  const existing = readEvents();
  // A profile event carries the provider's date, so it beats a secondary-only claim for the same ID.
  const merge = mergeEvents(existing, uniqueById([...consolidated.filter((e) => e.confidence === "high"), ...profiles, ...consolidated, ...diffEvents]), healthy, opts.today);
  const finalModels = applyStatus(models, merge.events, opts.today).sort((a, b) => modelKey(a).localeCompare(modelKey(b)));

  const eventsChanged = merge.added.length + merge.amended.length + merge.unlisted.length > 0;
  const modelsChanged = JSON.stringify(finalModels) !== JSON.stringify(previous?.models ?? []);
  const stale = daysSince(previous?.generated_at, opts.today) >= REFRESH_AFTER_DAYS;
  const changed = eventsChanged || modelsChanged || stale;

  const snapshot: RegistrySnapshot = {
    version: 1,
    generated_at: changed ? opts.now : previous?.generated_at ?? opts.now,
    events: merge.events.map(toPublic),
    models: finalModels,
  };

  const problems = validateSnapshot(snapshot);
  if (problems.length) fail(`The snapshot failed validation and was not written:\n${problems.slice(0, 20).join("\n")}`, 2);
  const removal = checkRemovals(previous, snapshot);
  if (!removal.ok) fail(removal.message!, 2);

  const primaryIds = new Set(consolidated.filter((e) => e.confidence === "high").map((e) => e.id));
  const secondaryModelChange = diff.changed + diff.added + diff.removed > 0;
  const nonPrimaryEvent = [...merge.added, ...merge.amended].some((id) => !primaryIds.has(id));

  const report = {
    generated_at: snapshot.generated_at,
    run_date: opts.today,
    offline: opts.offline,
    changed,
    material: eventsChanged || modelsChanged,
    // Auto-merge is only allowed when every change traces to a provider's own page or API.
    all_primary: !nonPrimaryEvent && !secondaryModelChange && outcomes.every((o) => o.ok || o.kind === "secondary"),
    sources: outcomes,
    failures: outcomes.filter((o) => !o.ok).map((o) => ({ id: o.id, urls: o.urls, error: o.error })),
    warnings: outcomes.flatMap((o) => o.warnings),
    added: merge.added,
    amended: merge.amended,
    unlisted: merge.unlisted,
    model_changes: { changed: diff.changed, added: diff.added, removed: diff.removed },
    cross_check: crossCheck,
    removal_check: removal,
    counts: { events: snapshot.events.length, models: snapshot.models.length },
  };

  if (!opts.dryRun) {
    // Files change only when an event does; last_verified alone would rewrite every file on every run.
    for (const event of merge.events) {
      const path = join(ROOT, "events", event.provider, `${event.id}.json`);
      let current: StoredEvent | null = null;
      try {
        current = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // New event file.
      }
      const withoutVerified = (e: StoredEvent) => JSON.stringify({ ...e, last_verified: "" });
      if (!current || withoutVerified(current) !== withoutVerified(event)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(event, null, 2)}\n`);
      }
    }
    if (changed) {
      const bytes = Buffer.from(serializeSnapshot(snapshot));
      mkdirSync(join(ROOT, "dist"), { recursive: true });
      writeFileSync(join(ROOT, "dist/snapshot.json"), bytes);
      writeFileSync(join(ROOT, "dist/feed.xml"), buildFeed(snapshot.events, snapshot.generated_at, SITE_URL));
      writeFileSync(join(ROOT, "dist/calendar.json"), buildCalendar(snapshot.events, opts.today, snapshot.generated_at));
      const key = process.env.REGISTRY_SIGNING_KEY_PEM;
      if (key) writeFileSync(join(ROOT, "dist/snapshot.json.sig"), signBytes(bytes, key));
      else process.stderr.write("REGISTRY_SIGNING_KEY_PEM is not set; the snapshot was not signed.\n");
    }
    writeJson(join(ROOT, "out/run-report.json"), report);
  }

  process.stdout.write(`${summarize(report, opts)}\n`);
}

function uniqueById(events: Consolidated[]): Consolidated[] {
  const seen = new Map<string, Consolidated>();
  for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e);
  return [...seen.values()];
}

function dedupeModels(models: RegistryModel[]): RegistryModel[] {
  const seen = new Map<string, RegistryModel>();
  for (const m of models) if (!seen.has(modelKey(m))) seen.set(modelKey(m), m);
  return [...seen.values()];
}

function summarize(r: { counts: { events: number; models: number }; changed: boolean; all_primary: boolean; added: string[]; amended: string[]; unlisted: string[]; failures: Array<{ id: string; error?: string }>; cross_check: unknown[] }, opts: Options): string {
  return [
    `${opts.dryRun ? "dry run: " : ""}${r.counts.events} events, ${r.counts.models} models`,
    `added ${r.added.length}, amended ${r.amended.length}, no longer listed ${r.unlisted.length}`,
    `source failures: ${r.failures.length}, date disagreements with secondaries: ${r.cross_check.length}`,
    `changed: ${r.changed}, all primary: ${r.all_primary}`,
    ...r.failures.map((f) => `failed: ${f.id}: ${f.error ?? "unknown error"}`),
  ].join("\n");
}

await main();
