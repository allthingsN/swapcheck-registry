/** Pure registry logic: consolidation, identity, merging, guards. No I/O and no clock. */
import type {
  Candidate,
  Confidence,
  RegistryEvent,
  RegistryModel,
  RegistrySnapshot,
  SourceKind,
  StoredEvent,
} from "./types.ts";

export interface Observed extends Candidate {
  sourceId: string;
  kind: SourceKind;
}

export function eventId(c: Candidate): string {
  const parts = [c.route, c.type, slug(c.model)];
  if (c.variant) parts.push(slug(c.variant));
  return parts.join(".");
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/\//g, "__")
    .replace(/:/g, "..")
    .replace(/@/g, "_at_")
    .replace(/[^a-z0-9._-]/g, "-");
}

export interface Consolidated {
  candidate: Candidate;
  id: string;
  confidence: Confidence;
  origin: string;
}

export interface CrossCheck {
  route: string;
  model: string;
  primary_date?: string;
  secondary_date?: string;
  secondary: string;
}

const END_OF_ROUTE = new Set(["retirement", "reroute"]);

/**
 * Applies the confidence rule. Primary facts win outright and are never decorated with
 * secondary successors. Secondary-only facts need agreement on the date to reach medium.
 */
export function consolidate(observed: Observed[], today: string): { events: Consolidated[]; crossCheck: CrossCheck[] } {
  const primary = new Map<string, Observed[]>();
  const secondaryByTarget = new Map<string, Observed[]>();
  for (const o of observed) {
    if (o.kind === "primary") {
      const id = eventId(o);
      if (!primary.has(id)) primary.set(id, []);
      primary.get(id)!.push(o);
    } else {
      const key = targetKey(o);
      if (!secondaryByTarget.has(key)) secondaryByTarget.set(key, []);
      secondaryByTarget.get(key)!.push(o);
    }
  }

  const events: Consolidated[] = [];
  const primaryTargets = new Map<string, Observed>();
  for (const [id, group] of primary) {
    const chosen = group[0];
    events.push({ candidate: stripInternal(chosen), id, confidence: "high", origin: chosen.sourceId });
    if (END_OF_ROUTE.has(chosen.type)) primaryTargets.set(targetKey(chosen), chosen);
  }

  const crossCheck: CrossCheck[] = [];
  for (const [key, group] of secondaryByTarget) {
    const claims = group.filter((c) => c.type === "retirement");
    const isNew = group.some((c) => c.type === "new_model");
    const known = primaryTargets.get(key);
    if (known) {
      for (const claim of claims) {
        if (claim.effective !== known.effective) {
          crossCheck.push({
            route: claim.route,
            model: claim.model,
            primary_date: known.effective,
            secondary_date: claim.effective,
            secondary: claim.sourceId,
          });
        }
      }
      continue;
    }
    if (isNew) {
      const newClaim = group.find((c) => c.type === "new_model")!;
      const id = eventId(newClaim);
      if (!primary.has(id)) events.push({ candidate: stripInternal(newClaim), id, confidence: "low", origin: newClaim.sourceId });
    }
    if (!claims.length) continue;
    // A single third-party date in the past tells a team nothing they can act on.
    if (claims.every((c) => !c.effective || c.effective < today)) continue;
    events.push(mergeSecondaryClaims(claims));
  }
  events.sort((a, b) => a.id.localeCompare(b.id));
  crossCheck.sort((a, b) => `${a.route}${a.model}`.localeCompare(`${b.route}${b.model}`));
  return { events, crossCheck };
}

function mergeSecondaryClaims(claims: Observed[]): Consolidated {
  const byDate = new Map<string, Observed[]>();
  for (const c of claims) {
    const date = c.effective ?? "";
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(c);
  }
  const agreed = [...byDate.entries()].find(([, group]) => new Set(group.map((g) => g.sourceId)).size >= 2);
  const chosen = agreed ? agreed[1][0] : [...claims].sort((a, b) => (a.effective ?? "").localeCompare(b.effective ?? ""))[0];
  const inferredTo = claims.find((c) => c.to);
  const namedTo = chosen.to ?? inferredTo?.to;
  const confidence: Confidence = agreed && !namedTo ? "medium" : "low";
  const candidate: Candidate = {
    ...stripInternal(chosen),
    ...(namedTo ? { to: namedTo, successor_basis: "inferred" as const } : { successor_basis: "none" as const }),
    notes: agreed
      ? `Date agreed by ${[...new Set(agreed[1].map((g) => g.sourceId))].join(" and ")}; not on the provider's own page.${namedTo ? " The successor is inferred." : ""}`
      : `Single secondary source (${chosen.sourceId}); not on the provider's own page.${claims.length > 1 ? " Secondary sources disagree on the date; the earliest is shown." : ""}`,
  };
  return { candidate, id: eventId(chosen), confidence, origin: chosen.sourceId };
}

function targetKey(c: Candidate): string {
  return `${c.route}\u0000${c.model}`;
}

function stripInternal(o: Observed): Candidate {
  const { sourceId: _s, kind: _k, ...candidate } = o;
  return candidate;
}

/** Fields whose change is an amendment. `last_verified` and bookkeeping are excluded. */
const MATERIAL_FIELDS = ["type", "provider", "route", "model", "to", "effective", "date_precision", "billing", "successor_basis", "params", "region_schedule", "source", "confidence", "report_url", "notes"] as const;

export interface MergeResult {
  events: StoredEvent[];
  added: string[];
  amended: string[];
  unlisted: string[];
}

/**
 * Applies this run's facts to the stored events. Stored events are never removed; a healthy
 * source that stops listing an event only sets `not_listed_since`.
 */
export function mergeEvents(existing: StoredEvent[], current: Consolidated[], healthySources: Set<string>, today: string): MergeResult {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const added: string[] = [];
  const amended: string[] = [];
  const unlisted: string[] = [];

  for (const c of current) {
    seen.add(c.id);
    const old = byId.get(c.id);
    const next: StoredEvent = {
      id: c.id,
      type: c.candidate.type,
      provider: c.candidate.provider,
      route: c.candidate.route,
      model: c.candidate.model,
      ...optional(c.candidate),
      source: c.candidate.source,
      confidence: c.confidence,
      first_seen: old?.first_seen ?? today,
      last_verified: today,
      origin: c.origin,
      ...(old?.history?.length ? { history: old.history } : {}),
    };
    if (!old) {
      byId.set(c.id, next);
      added.push(c.id);
      continue;
    }
    const previous: Record<string, unknown> = {};
    for (const field of MATERIAL_FIELDS) {
      if (JSON.stringify(old[field]) !== JSON.stringify(next[field])) previous[field] = old[field] ?? null;
    }
    if (Object.keys(previous).length) {
      next.history = [...(old.history ?? []), { amended_at: today, previous: previous as Partial<RegistryEvent> }];
      amended.push(c.id);
    }
    byId.set(c.id, next);
  }

  for (const old of existing) {
    if (seen.has(old.id) || !healthySources.has(old.origin) || old.not_listed_since) continue;
    if (old.type === "new_model") continue; // Parsers stop emitting new_model after the window; that is not a change.
    byId.set(old.id, { ...old, not_listed_since: today });
    unlisted.push(old.id);
  }

  const events = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { events, added, amended, unlisted };
}

function optional(c: Candidate): Partial<RegistryEvent> {
  const o: Partial<RegistryEvent> = {};
  if (c.to) o.to = c.to;
  if (c.effective) o.effective = c.effective;
  if (c.date_precision) o.date_precision = c.date_precision;
  if (c.billing) o.billing = c.billing;
  if (c.successor_basis) o.successor_basis = c.successor_basis;
  if (c.params) o.params = c.params;
  if (c.region_schedule) o.region_schedule = c.region_schedule;
  if (c.notes) o.notes = c.notes;
  return o;
}

const BEDROCK_PROFILE = /^(us-gov|us|eu|au|apac|jp|in|ca|sa|global)\./;

/** Regions a geographic inference profile routes to. `global` reaches every region, so it has no filter. */
const PROFILE_REGIONS: Record<string, RegExp | undefined> = {
  "us-gov": /^us-gov-/,
  us: /^us-(?:east|west)-\d$/,
  eu: /^eu-/,
  au: /^ap-southeast-[24]$/,
  apac: /^ap-/,
  jp: /^ap-northeast-[13]$/,
  in: /^ap-south-[12]$/,
  ca: /^ca-/,
  sa: /^sa-/,
  global: undefined,
};

/** Keeps only the schedule rows a profile can reach; null when the change does not reach it at all. */
function profileCandidate(base: Candidate, profile: string, geo: string): Candidate | null {
  const reach = PROFILE_REGIONS[geo];
  if (!reach || !base.region_schedule) return { ...base, model: profile };
  const rows = base.region_schedule.filter((row) => row.regions.some((region) => reach.test(region)));
  if (!rows.length) return null;
  const regions = rows.map((row) => ({ regions: row.regions.filter((region) => reach.test(region)), effective: row.effective }));
  return { ...base, model: profile, region_schedule: regions, effective: regions.map((row) => row.effective).sort()[0] };
}

/**
 * AWS publishes EOL dates on base model IDs, while most callers use inference-profile IDs
 * (for example `us.anthropic...`). Those need a warning too, marked low because the mapping is inferred.
 */
export function bedrockProfileEvents(events: Consolidated[], modelIds: string[]): Consolidated[] {
  const profilesByBase = new Map<string, Array<{ id: string; geo: string }>>();
  for (const id of modelIds) {
    const m = BEDROCK_PROFILE.exec(id);
    if (!m) continue;
    const base = id.slice(m[0].length);
    if (!profilesByBase.has(base)) profilesByBase.set(base, []);
    profilesByBase.get(base)!.push({ id, geo: m[1] });
  }
  const out: Consolidated[] = [];
  for (const e of events) {
    if (e.candidate.route !== "aws-bedrock" || e.candidate.type !== "retirement" || e.confidence !== "high") continue;
    for (const { id: profile, geo } of profilesByBase.get(e.candidate.model) ?? []) {
      const reached = profileCandidate(e.candidate, profile, geo);
      // A retirement listed only for regions this profile never routes to does not affect it.
      if (!reached) continue;
      const candidate: Candidate = {
        ...reached,
        notes: `Inference profile of ${e.candidate.model}. AWS publishes the date for the base model; applying it to this profile is inferred, and profile coverage can differ by region.`,
      };
      out.push({ candidate, id: eventId(candidate), confidence: "low", origin: e.origin });
    }
  }
  return out;
}

/** Applies lifecycle facts to model status. A passed floor date does not make a model retired. */
export function applyStatus(models: RegistryModel[], events: StoredEvent[], today: string): RegistryModel[] {
  const relevant = new Map<string, StoredEvent[]>();
  for (const e of events) {
    if (e.type !== "retirement" && e.type !== "reroute") continue;
    const key = `${e.route}\u0000${e.model}`;
    if (!relevant.has(key)) relevant.set(key, []);
    relevant.get(key)!.push(e);
  }
  return models.map((m) => {
    const list = relevant.get(`${m.route}\u0000${m.id}`);
    if (!list) return m;
    const retiredNow = list.some((e) => e.type === "retirement" && e.confidence === "high" && e.date_precision === "exact" && !!e.effective && e.effective <= today);
    return { ...m, status: retiredNow ? "retired" : "deprecated" };
  });
}

export interface RemovalCheck {
  ok: boolean;
  models: { before: number; removed: number };
  events: { before: number; removed: number };
  message?: string;
}

/** A run that would drop more than this share of models or events must not publish. */
export const MAX_REMOVAL = 0.2;

export function checkRemovals(prev: RegistrySnapshot | null, next: RegistrySnapshot): RemovalCheck {
  const beforeModels = prev?.models.length ?? 0;
  const beforeEvents = prev?.events.length ?? 0;
  const nextModels = new Set(next.models.map(modelKey));
  const nextEvents = new Set(next.events.map((e) => e.id));
  const removedModels = prev?.models.filter((m) => !nextModels.has(modelKey(m))).length ?? 0;
  const removedEvents = prev?.events.filter((e) => !nextEvents.has(e.id)).length ?? 0;
  const result: RemovalCheck = {
    ok: true,
    models: { before: beforeModels, removed: removedModels },
    events: { before: beforeEvents, removed: removedEvents },
  };
  if ((beforeModels && removedModels / beforeModels > MAX_REMOVAL) || (beforeEvents && removedEvents / beforeEvents > MAX_REMOVAL)) {
    result.ok = false;
    result.message = `Refusing to publish: this run would remove ${removedModels} of ${beforeModels} models and ${removedEvents} of ${beforeEvents} events, over the ${MAX_REMOVAL * 100}% limit.`;
  }
  return result;
}

export function modelKey(m: Pick<RegistryModel, "route" | "id">): string {
  return `${m.route}\u0000${m.id}`;
}

/** Keeps a model from a source that failed this run, so a broken parser cannot delete data. */
export function carryForward(prev: RegistrySnapshot | null, current: RegistryModel[], failedSourceUrls: Set<string>): RegistryModel[] {
  if (!prev) return current;
  const present = new Set(current.map(modelKey));
  return [...current, ...prev.models.filter((m) => failedSourceUrls.has(m.source) && !present.has(modelKey(m)))];
}

export function toPublic(e: StoredEvent): RegistryEvent {
  const { origin: _o, history: _h, not_listed_since: _n, ...rest } = e;
  return rest;
}

const EVENT_TYPES = new Set(["retirement", "reroute", "alias_move", "price_change", "parameter_change", "capability_change", "new_model"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_URL = /^https:\/\/[^\s]+$/;

/** Enforces the contract before anything is written or signed. */
export function validateSnapshot(s: RegistrySnapshot): string[] {
  const problems: string[] = [];
  if (s.version !== 1) problems.push("version must be 1");
  if (Number.isNaN(Date.parse(s.generated_at))) problems.push("generated_at is not a date");
  const ids = new Set<string>();
  for (const e of s.events) {
    if (ids.has(e.id)) problems.push(`duplicate event id ${e.id}`);
    ids.add(e.id);
    if (!EVENT_TYPES.has(e.type)) problems.push(`${e.id}: unknown type`);
    if (!["high", "medium", "low"].includes(e.confidence)) problems.push(`${e.id}: unknown confidence`);
    if (!e.provider || !e.route || !e.model) problems.push(`${e.id}: missing provider, route or model`);
    if (e.effective && !ISO_DATE.test(e.effective)) problems.push(`${e.id}: effective is not a date`);
    if (!SAFE_URL.test(e.source)) problems.push(`${e.id}: source is not an https URL`);
    if (!ISO_DATE.test(e.first_seen) || !ISO_DATE.test(e.last_verified)) problems.push(`${e.id}: bad first_seen or last_verified`);
    if (e.type === "parameter_change" && !e.params?.length) problems.push(`${e.id}: parameter_change without params`);
    if (e.effective && !e.date_precision) problems.push(`${e.id}: effective date without precision`);
    if (e.region_schedule) {
      const rows = e.region_schedule;
      if (!rows.length || rows.some((row) => !row.regions.length || !ISO_DATE.test(row.effective))) problems.push(`${e.id}: bad region_schedule`);
      else if (e.effective !== rows.map((row) => row.effective).sort()[0]) problems.push(`${e.id}: effective is not the earliest region date`);
    }
  }
  const models = new Set<string>();
  for (const m of s.models) {
    const key = modelKey(m);
    if (models.has(key)) problems.push(`duplicate model ${m.route}/${m.id}`);
    models.add(key);
    if (!m.id || !m.provider || !m.route || !m.name) problems.push(`model ${m.id}: missing identity`);
    if (typeof m.cost.input !== "number" || m.cost.input < 0 || typeof m.cost.output !== "number" || m.cost.output < 0) problems.push(`model ${m.id}: bad cost`);
    if (m.limit.context < 1) problems.push(`model ${m.id}: bad context limit`);
  }
  return problems;
}

/** Reports field-level differences between snapshots as observed events. */
export function diffModels(prev: RegistrySnapshot | null, next: RegistryModel[], today: string): { candidates: Candidate[]; changed: number; added: number; removed: number } {
  if (!prev) return { candidates: [], changed: 0, added: next.length, removed: 0 };
  const before = new Map(prev.models.map((m) => [modelKey(m), m]));
  const nextKeys = new Set(next.map(modelKey));
  const candidates: Candidate[] = [];
  let changed = 0;
  let added = 0;
  for (const m of next) {
    const old = before.get(modelKey(m));
    if (!old) {
      added++;
      continue;
    }
    const base = { provider: m.provider, route: m.route, model: m.id, effective: today, date_precision: "estimated" as const, source: m.source, variant: today };
    const priced = old.cost.input !== m.cost.input || old.cost.output !== m.cost.output;
    const caps = JSON.stringify(old.capabilities) !== JSON.stringify(m.capabilities);
    if (priced) {
      candidates.push({ ...base, type: "price_change", billing: "unknown", notes: `Input ${old.cost.input} to ${m.cost.input}, output ${old.cost.output} to ${m.cost.output} USD per million tokens, observed in ${m.source}.` });
    }
    if (caps) {
      candidates.push({ ...base, type: "capability_change", notes: `Capabilities changed from ${capabilityList(old)} to ${capabilityList(m)}, observed in ${m.source}.` });
    }
    if (priced || caps) changed++;
  }
  const removed = prev.models.filter((m) => !nextKeys.has(modelKey(m))).length;
  return { candidates, changed, added, removed };
}

function capabilityList(m: RegistryModel): string {
  const on = Object.entries(m.capabilities).filter(([, v]) => v).map(([k]) => k);
  return on.length ? on.join(", ") : "none";
}
