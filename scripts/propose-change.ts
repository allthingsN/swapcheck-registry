/**
 * Lands a registry update on main when every change comes from a provider's own page or API.
 * Otherwise pushes a branch and opens an issue asking for review: the organization does not let
 * GitHub Actions open pull requests. Uses execFile with argument arrays, never a shell.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

interface Report {
  run_date: string;
  changed: boolean;
  all_primary: boolean;
  added: string[];
  amended: string[];
  unlisted: string[];
  counts: { events: number; models: number };
  model_changes: { changed: number; added: number; removed: number };
}

const report = JSON.parse(readFileSync("out/run-report.json", "utf8")) as Report;
if (!report.changed) {
  process.stdout.write("No registry changes this run.\n");
  process.exit(0);
}

run("git", ["config", "user.name", "swapcheck-registry-bot"]);
run("git", ["config", "user.email", "registry-bot@users.noreply.github.com"]);
run("git", ["add", "--", "events", "dist"]);
if (!run("git", ["diff", "--cached", "--name-only"])) {
  process.stdout.write("Nothing changed on disk.\n");
  process.exit(0);
}

const title = `registry: ${report.added.length} added, ${report.amended.length} amended (${report.run_date})`;
run("git", ["commit", "-m", title]);

if (report.all_primary) {
  run("git", ["push", "origin", "HEAD:main"]);
  process.stdout.write("Every change is confirmed by a primary source, so it was pushed to main.\n");
  process.exit(0);
}

const branch = `registry-update-${process.env.GITHUB_RUN_ID ?? report.run_date}`;
run("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);
const repo = process.env.GITHUB_REPOSITORY ?? "allthingsN/swapcheck-registry";
const body = [
  `Events: ${report.counts.events}. Models: ${report.counts.models}.`,
  `Added ${report.added.length}, amended ${report.amended.length}, no longer listed by their source ${report.unlisted.length}.`,
  `Model rows changed ${report.model_changes.changed}, added ${report.model_changes.added}, removed ${report.model_changes.removed}.`,
  "",
  "At least one change comes from a secondary source or is inferred, so it needs review before it reaches main.",
  `Review and open a pull request: https://github.com/${repo}/compare/main...${branch}`,
].join("\n");
const url = run("gh", ["issue", "create", "--title", `Review ${title}`, "--body", body]);
process.stdout.write(`${url}\n`);
