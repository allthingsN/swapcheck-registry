/** Opens one GitHub issue per broken parser, de-duplicated by title. Reads out/run-report.json. */
import { readFileSync } from "node:fs";

interface Failure {
  id: string;
  urls: string[];
  error?: string;
}

async function github(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "swapcheck-registry",
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} returned ${res.status}.`);
  return res.status === 204 ? null : res.json();
}

const repo = process.env.GITHUB_REPOSITORY;
if (!repo || !process.env.GITHUB_TOKEN) {
  process.stderr.write("GITHUB_REPOSITORY and GITHUB_TOKEN are required to open issues.\n");
  process.exit(2);
}

const report = JSON.parse(readFileSync(process.argv[2] ?? "out/run-report.json", "utf8")) as { failures: Failure[] };
for (const failure of report.failures) {
  const title = `Parser ${failure.id} no longer matches its source`;
  const open = (await github(`/repos/${repo}/issues?state=open&per_page=100`)) as Array<{ title: string }>;
  if (open.some((i) => i.title === title)) continue;
  const body = [
    `The \`${failure.id}\` parser could not read its source on the latest scheduled run, so its data was kept unchanged and nothing was published from it.`,
    "",
    `Error: ${failure.error ?? "unknown"}`,
    "",
    "Sources:",
    ...failure.urls.map((u) => `- ${u}`),
    "",
    "To fix: record a new fixture with the current page and update the parser so its test passes. See CONTRIBUTING.md.",
  ].join("\n");
  await github(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body, labels: ["parser-failure"] }) });
  process.stdout.write(`Opened an issue for ${failure.id}.\n`);
}
