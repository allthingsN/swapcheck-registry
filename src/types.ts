/**
 * Output contract: mirrors RegistryEvent, RegistryModel and RegistrySnapshot in
 * swapcheck/src/types.ts. Keep the shapes identical; the client verifies and trusts these.
 */
export type EventType =
  | "retirement"
  | "reroute"
  | "alias_move"
  | "price_change"
  | "parameter_change"
  | "capability_change"
  | "new_model";

export type Confidence = "high" | "medium" | "low";
export type DatePrecision = "exact" | "earliest_possible" | "estimated";

export interface RegionDate {
  regions: string[];
  effective: string;
}

export interface RegistryEvent {
  id: string;
  type: EventType;
  provider: string;
  route: string;
  model: string;
  to?: string;
  effective?: string;
  date_precision?: DatePrecision;
  billing?: "replacement_rates" | "unchanged" | "unknown";
  successor_basis?: "provider_named" | "inferred" | "none";
  params?: string[];
  /**
   * Set when the change only covers some regions, as on Amazon Bedrock. `effective` is then the earliest row's date.
   * A region not listed has no announced change.
   */
  region_schedule?: RegionDate[];
  source: string;
  confidence: Confidence;
  first_seen: string;
  last_verified: string;
  report_url?: string;
  notes?: string;
}

export interface ModelCapabilities {
  tools: boolean;
  structured_output: boolean;
  reasoning: boolean;
  vision: boolean;
  audio: boolean;
  pdf: boolean;
}

export interface RegistryModel {
  id: string;
  provider: string;
  route: string;
  name: string;
  family?: string;
  release_date?: string;
  status: "active" | "deprecated" | "retired" | "unknown";
  capabilities: ModelCapabilities;
  limit: { context: number; output: number };
  cost: { input: number; output: number };
  license?: string;
  open_weights?: boolean;
  region?: string[];
  source: string;
}

export interface RegistrySnapshot {
  version: 1;
  generated_at: string;
  events: RegistryEvent[];
  models: RegistryModel[];
}

/** Registry-only additions to an event file. Stripped from the published snapshot. */
export interface StoredEvent extends RegistryEvent {
  /** Parser id that last wrote this event. */
  origin: string;
  /** Earlier values of amended fields, oldest first. */
  history?: EventAmendment[];
  /** First date a healthy parser stopped listing this event. The event stays. */
  not_listed_since?: string;
}

export interface EventAmendment {
  amended_at: string;
  previous: Partial<RegistryEvent>;
}

/** What a parser reports before identity, dates and corroboration are applied. */
export interface Candidate {
  type: EventType;
  provider: string;
  route: string;
  model: string;
  to?: string;
  effective?: string;
  date_precision?: DatePrecision;
  billing?: RegistryEvent["billing"];
  successor_basis?: RegistryEvent["successor_basis"];
  params?: string[];
  region_schedule?: RegionDate[];
  source: string;
  notes?: string;
  /** Distinguishes otherwise identical events, e.g. an Azure version. */
  variant?: string;
}

export type SourceKind = "primary" | "secondary";

export interface ParseContext {
  /** Run date, YYYY-MM-DD. Parsers must not read the clock. */
  today: string;
}

export interface ParseResult {
  candidates: Candidate[];
  models?: RegistryModel[];
  warnings?: string[];
}

export interface SourceDef {
  id: string;
  kind: SourceKind;
  /** Local fixture file name to live URL. */
  files: Record<string, string>;
  parse(pages: Record<string, string>, ctx: ParseContext): ParseResult;
}

/** Raised when a page no longer has the structure a parser expects. */
export class ParseMismatchError extends Error {
  readonly source: string;
  constructor(source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = "ParseMismatchError";
    this.source = source;
  }
}
