/**
 * Turns a registry update into a pull request, and merges it only when every change
 * comes from a provider's own page or API. Uses execFile with argument arrays, never a shell.
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

const branch = `registry-update-${process.env.GITHUB_RUN_ID ?? report.run_date}`;
const title = `registry: ${report.added.length} added, ${report.amended.length} amended (${report.run_date})`;
run("git", ["switch", "-c", branch]);
run("git", ["commit", "-m", title]);
run("git", ["push", "--set-upstream", "origin", branch]);

const body = [
  `Events: ${report.counts.events}. Models: ${report.counts.models}.`,
  `Added ${report.added.length}, amended ${report.amended.length}, no longer listed by their source ${report.unlisted.length}.`,
  `Model rows changed ${report.model_changes.changed}, added ${report.model_changes.added}, removed ${report.model_changes.removed}.`,
  "",
  report.all_primary ? "Every change is confirmed by a primary source, so this pull request merges automatically." : "At least one change comes from a secondary source or is inferred, so this pull request needs review.",
].join("\n");

const url = run("gh", ["pr", "create", "--title", title, "--body", body, "--head", branch, "--base", "main"]);
process.stdout.write(`${url}\n`);
if (report.all_primary) run("gh", ["pr", "merge", url, "--squash", "--delete-branch"]);
