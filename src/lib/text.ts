/** Deterministic text helpers shared by parsers. Everything here treats web content as inert data. */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const iso = (y: number, m: number, d: number): string | null => {
  if (y < 2020 || y > 2040 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

/**
 * Whole-string date parser. Qualified values like "October 13, 2027 or later" or
 * "To be announced" must return null so a floor or placeholder is never read as a date.
 */
export function parseDate(raw: string): string | null {
  const s = raw.replace(/\s+/g, " ").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(s);
  if (m) return iso(2000 + +m[3], +m[1], +m[2]);
  return null;
}

/** Azure writes footnotes as "2027-04-14^3^" in markdown and "2027-04-143" in rendered text. */
export function parseFootnotedIsoDate(raw: string): string | null {
  const s = stripTags(raw).replace(/\^\d+\^/g, "").trim();
  const m = /^(\d{4}-\d{2}-\d{2})\d?$/.exec(s);
  return m ? parseDate(m[1]) : null;
}

export function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Removes tags until none are left, so nested input such as `<scr<script>ipt>` cannot leave a tag behind. */
function removeTags(s: string): string {
  let out = s;
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(/<[^<>]*>/g, "");
  }
  return out;
}

/** Plain text from HTML. Entities are decoded last, and any tag they spell out is removed too. */
export function stripTags(s: string): string {
  return removeTags(decodeEntities(removeTags(s)));
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

export function isModelId(s: string): boolean {
  return s.length > 0 && s.length <= 160 && MODEL_ID.test(s);
}

/** Model IDs written in backticks in a cell, in order, de-duplicated. */
export function idsIn(cell: string): string[] {
  const out: string[] = [];
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    if (isModelId(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export interface Section {
  level: number;
  title: string;
  parents: string[];
  body: string;
}

/** Splits a document by ATX headings; `body` runs to the next heading of any level. */
export function mdSections(md: string): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let current: Section | null = null;
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const title = cleanHeading(h[2]);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      current = { level, title, parents: stack.map((s) => s.title), body: "" };
      sections.push(current);
      stack.push({ level, title });
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return sections;
}

function cleanHeading(raw: string): string {
  return normalizeSpace(
    raw
      .replace(/\{%.*?%\}/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`/g, ""),
  );
}

export interface Table {
  headers: string[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** GitHub-style pipe tables in a block of markdown. */
export function mdTables(body: string): Table[] {
  const tables: Table[] = [];
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    if (!/^\s*\|\s*:?-{1,}/.test(lines[i + 1])) continue;
    const headers = splitRow(lines[i]).map((h) => normalizeSpace(h));
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) rows.push(splitRow(lines[j]));
    tables.push({ headers, rows });
    i = j - 1;
  }
  return tables;
}

export function col(headers: string[], pattern: RegExp): number {
  return headers.findIndex((h) => pattern.test(h));
}

/** Strips markdown links, keeping link text. */
export function unlink(s: string): string {
  return s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

export interface HtmlTable extends Table {
  /** Nearest h2 or h3 preceding the table. */
  heading: string;
  /** Every h2 and h3 before the table, in order. Nested groups use this to find their parent. */
  headingTrail: string[];
}

/** Minimal HTML table reader. Handles rowspan and colspan; nested tables are not expected. */
export function htmlTables(html: string): HtmlTable[] {
  const out: HtmlTable[] = [];
  let heading = "";
  const trail: string[] = [];
  const re = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1>|<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  for (const m of html.matchAll(re)) {
    if (m[2] !== undefined) {
      heading = normalizeSpace(stripTags(m[2]));
      trail.push(heading);
      continue;
    }
    const grid = tableGrid(m[3]);
    if (grid.length) out.push({ heading, headingTrail: [...trail], headers: grid[0], rows: grid.slice(1) });
  }
  return out;
}

function tableGrid(tableHtml: string): string[][] {
  const grid: string[][] = [];
  const pending: Array<{ left: number; text: string } | undefined> = [];
  for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row: string[] = [];
    let colIndex = 0;
    const flushSpans = () => {
      while (pending[colIndex]) {
        const span = pending[colIndex]!;
        row[colIndex] = span.text;
        if (--span.left === 0) pending[colIndex] = undefined;
        colIndex++;
      }
    };
    for (const cell of rowMatch[1].matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      flushSpans();
      const text = normalizeSpace(stripTags(cell[3]));
      const rowspan = +(/rowspan\s*=\s*"?(\d+)/i.exec(cell[2])?.[1] ?? 1);
      const colspan = +(/colspan\s*=\s*"?(\d+)/i.exec(cell[2])?.[1] ?? 1);
      for (let k = 0; k < colspan; k++) {
        row[colIndex] = text;
        if (rowspan > 1) pending[colIndex] = { left: rowspan - 1, text };
        colIndex++;
      }
    }
    flushSpans();
    if (row.length) grid.push(row.map((c) => c ?? ""));
  }
  return grid;
}

/** Days from `a` to `b`, both ISO dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
