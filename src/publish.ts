import { createPrivateKey, sign } from "node:crypto";
import type { RegistryEvent, RegistrySnapshot } from "./types.ts";

/** Detached Ed25519 signature over exact bytes, base64-encoded. */
export function signBytes(bytes: Uint8Array, privateKeyPem: string): string {
  return sign(null, bytes, createPrivateKey(privateKeyPem)).toString("base64");
}

export function serializeSnapshot(snapshot: RegistrySnapshot): string {
  return `${JSON.stringify(snapshot)}\n`;
}

const FEED_LIMIT = 250;

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 forbids; web-sourced IDs should never carry these, but the feed must stay valid.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function describe(e: RegistryEvent): string {
  const when = e.effective ? `${e.date_precision === "earliest_possible" ? "no earlier than" : "on"} ${e.effective}` : "date not stated";
  const verb: Record<RegistryEvent["type"], string> = {
    retirement: "retires",
    reroute: "reroutes",
    alias_move: "alias moves",
    price_change: "price changes",
    parameter_change: "parameters change",
    capability_change: "capabilities change",
    new_model: "released",
  };
  const to = e.to ? ` to ${e.to}` : "";
  return `${e.model} (${e.route}) ${verb[e.type]}${to} ${when}. Confidence: ${e.confidence}.`;
}

/** Newest first by first_seen. New retirements and reroutes are what readers subscribe for. */
export function buildFeed(events: RegistryEvent[], generatedAt: string, siteUrl: string): string {
  const items = [...events]
    .filter((e) => e.type !== "new_model")
    .sort((a, b) => b.first_seen.localeCompare(a.first_seen) || (b.effective ?? "").localeCompare(a.effective ?? "") || a.id.localeCompare(b.id))
    .slice(0, FEED_LIMIT);
  const channel = [
    `<title>Swapcheck registry changes</title>`,
    `<link>${xml(siteUrl)}</link>`,
    `<description>Hosted LLM model retirements, reroutes and changes, from provider pages.</description>`,
    `<lastBuildDate>${new Date(generatedAt).toUTCString()}</lastBuildDate>`,
  ];
  const body = items.map((e) => {
    const parts = [
      `<title>${xml(`${e.provider}: ${e.model}`)}</title>`,
      `<link>${xml(e.source)}</link>`,
      `<guid isPermaLink="false">${xml(e.id)}</guid>`,
      `<pubDate>${new Date(`${e.first_seen}T00:00:00Z`).toUTCString()}</pubDate>`,
      `<description>${xml(describe(e))}</description>`,
    ];
    return `<item>${parts.join("")}</item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>${channel.join("")}${body.join("")}</channel></rss>\n`;
}

export interface CalendarEntry {
  date: string;
  date_precision?: string;
  event_id: string;
  type: RegistryEvent["type"];
  provider: string;
  route: string;
  model: string;
  to?: string;
  confidence: RegistryEvent["confidence"];
  source: string;
}

/** Forward-looking schedule only. */
export function buildCalendar(events: RegistryEvent[], today: string, generatedAt: string): string {
  const entries: CalendarEntry[] = events
    .filter((e) => e.effective && e.effective >= today && e.type !== "new_model")
    .sort((a, b) => a.effective!.localeCompare(b.effective!) || a.id.localeCompare(b.id))
    .map((e) => ({
      date: e.effective!,
      ...(e.date_precision ? { date_precision: e.date_precision } : {}),
      event_id: e.id,
      type: e.type,
      provider: e.provider,
      route: e.route,
      model: e.model,
      ...(e.to ? { to: e.to } : {}),
      confidence: e.confidence,
      source: e.source,
    }));
  return `${JSON.stringify({ generated_at: generatedAt, entries }, null, 2)}\n`;
}
