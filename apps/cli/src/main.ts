// The fabrica commands. Each mirrors a /factory command in .claude/skills/factory/SKILL.md and drives @fabrica/runner.
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REVIEWERS, nextJobNumber } from "@fabrica/core";
import type { JobState } from "@fabrica/core";
import { approveJob, isValidJobId, reworkJob, runJob } from "@fabrica/runner";
import type { AgentExecutor, RunnerOptions } from "@fabrica/runner";

export interface CliDeps {
  cwd: string;
  executor: AgentExecutor;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = [
  "Usage: fabrica <command>",
  "",
  "Commands:",
  "  run <feature...>           create a job for a feature and run it",
  "  next                       claim the first unchecked item of factory/backlog.md and run it",
  "  approve <job-id>           merge a needs-human job",
  "  rework <job-id> <note...>  restart a needs-human job with a note for a fresh builder",
  "  status                     list the jobs in factory/jobs/",
];

const UNCHECKED = "- [ ] ";

export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv;
  if (command === "-h" || command === "--help") {
    for (const line of USAGE) deps.out(line);
    return 0;
  }
  const usage = (): number => {
    for (const line of USAGE) deps.err(line);
    return 1;
  };
  const text = args.join(" ");
  switch (command) {
    case "run":
      if (text.trim() === "") return usage();
      return withRepo(deps, (options) => runFeature(options, text));
    case "next":
      if (args.length > 0) return usage();
      return withRepo(deps, (options) => next(options, deps));
    case "approve": {
      if (args.length !== 1) return usage();
      const id = args[0]!;
      if (!validId(id, deps)) return 1;
      return withRepo(deps, (options) => approveJob(options, id));
    }
    case "rework": {
      const [id, ...words] = args;
      const note = words.join(" ");
      if (id === undefined || note.trim() === "") return usage();
      if (!validId(id, deps)) return 1;
      return withRepo(deps, (options) => reworkJob(options, id, note));
    }
    case "status":
      if (args.length > 0) return usage();
      return withRepo(deps, async (options) => {
        await status(options.repo, deps);
        return null;
      });
    default:
      return usage();
  }
}

// The job id's slug: the first 4 lowercase alphanumeric words of the feature, or "job" when there are none.
export function slug(feature: string): string {
  const words = feature
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  return words.slice(0, 4).join("-") || "job";
}

function validId(id: string, deps: CliDeps): boolean {
  if (isValidJobId(id)) return true;
  deps.err(`fabrica: invalid job id: ${id}`);
  return false;
}

// Resolves the repo, runs the command and prints its final "<job-id>: <stage>" line. null means there is no job to report.
async function withRepo(deps: CliDeps, command: (options: RunnerOptions) => Promise<JobState | null>): Promise<number> {
  const repo = await toplevel(deps.cwd);
  if (repo === null) {
    deps.err("fabrica: not inside a git repository");
    return 1;
  }
  const options: RunnerOptions = { repo, executor: deps.executor, notify: (message) => deps.out(message) };
  try {
    const job = await command(options);
    if (job !== null) deps.out(`${job.id}: ${job.stage}`);
    return 0;
  } catch (error) {
    deps.err(`fabrica: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function toplevel(cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }, (error, stdout) => {
      done(error ? null : stdout.trim());
    });
  });
}

// Creates the job under the next free number, picking the next one again when another session took the folder.
// beforeAttempt runs with each chosen id just before runJob.
async function runFeature(
  options: RunnerOptions,
  feature: string,
  beforeAttempt?: (id: string) => Promise<void>,
): Promise<JobState> {
  for (;;) {
    const id = `${nextJobNumber(await jobEntries(options.repo))}-${slug(feature)}`;
    await beforeAttempt?.(id);
    try {
      return await runJob(options, { id, feature });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
}

async function jobEntries(repo: string): Promise<string[]> {
  try {
    return await readdir(join(repo, "factory", "jobs"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function next(options: RunnerOptions, deps: CliDeps): Promise<JobState | null> {
  const file = join(options.repo, "factory", "backlog.md");
  const item = await claim(file);
  if (item === null) {
    deps.out("No unchecked items in factory/backlog.md.");
    return null;
  }
  let line = `- [x] ${item} → claimed`;
  return runFeature(options, item, async (id) => {
    const marked = `- [x] ${item} → ${id}`;
    const text = replaceLine(await readFile(file, "utf8"), line, marked);
    if (text === null) throw new Error(`${file} no longer has the line: ${line}`);
    await writeFile(file, text);
    line = marked;
  });
}

// Claims the first unchecked item by marking its line claimed. A line changed in the meantime means trying the next one.
async function claim(file: string): Promise<string | null> {
  for (;;) {
    const line = (await readBacklog(file)).split("\n").find((candidate) => candidate.startsWith(UNCHECKED));
    if (line === undefined) return null;
    const item = line.slice(UNCHECKED.length);
    const text = replaceLine(await readBacklog(file), line, `- [x] ${item} → claimed`);
    if (text === null) continue;
    await writeFile(file, text);
    return item;
  }
}

async function readBacklog(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error(`no backlog at ${file}`);
    throw error;
  }
}

// Replaces the first line equal to from, leaving every other byte as it was. null when no line matches.
function replaceLine(text: string, from: string, to: string): string | null {
  const lines = text.split("\n");
  const index = lines.indexOf(from);
  if (index === -1) return null;
  lines[index] = to;
  return lines.join("\n");
}

async function status(repo: string, deps: CliDeps): Promise<void> {
  const jobs = join(repo, "factory", "jobs");
  let ids: string[];
  try {
    const entries = await readdir(jobs, { withFileTypes: true });
    ids = entries.filter((entry) => entry.isDirectory() && isValidJobId(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    ids = [];
  }
  if (ids.length === 0) {
    deps.out("No jobs.");
    return;
  }
  for (const id of ids.sort()) deps.out(statusLine(id, await readJob(join(jobs, id, "job.json"))));
}

async function readJob(file: string): Promise<JobState | null> {
  try {
    const job: unknown = JSON.parse(await readFile(file, "utf8"));
    return typeof job === "object" && job !== null ? (job as JobState) : null;
  } catch {
    return null;
  }
}

function statusLine(id: string, job: JobState | null): string {
  if (job === null) return `${id}  (no readable job.json)`;
  const reviews = REVIEWERS.map((reviewer) => `${reviewer} ${job.reviews?.[reviewer]}`);
  return [id, job.stage, `round ${job.round}`, ...reviews].join("  ");
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
