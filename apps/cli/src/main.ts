// The fabrica commands. Each mirrors a /factory command in .claude/skills/factory/SKILL.md and drives @fabrica/runner.
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REVIEWERS, nextJobNumber } from "@fabrica/core";
import type { JobState } from "@fabrica/core";
import {
  approveJob,
  enqueueJob,
  isValidJobId,
  openJobStore,
  openQueue,
  reworkJob,
  runJob,
  startWorker,
} from "@fabrica/runner";
import type { AgentExecutor, JobStore, RunnerOptions, SetupRunner } from "@fabrica/runner";

export interface CliDeps {
  cwd: string;
  executor: AgentExecutor;
  // Docker mode: removes a job's container once its worktree is removed. Host mode has none.
  teardown?: (repo: string, id: string) => Promise<void>;
  // Docker mode: host git runs with fsmonitor and hooks off, since agents can write the repo's git dir.
  hardenGit?: boolean;
  // Docker mode: runs fabrica.yaml's setup command in the job's container. Host mode has none (the runner's default).
  runSetup?: SetupRunner;
  out: (line: string) => void;
  err: (line: string) => void;
  // DATABASE_URL: when set, run and next enqueue for a worker, and approve and rework keep the job store in step.
  databaseUrl?: string;
  // Stops fabrica worker.
  signal?: AbortSignal;
}

// The line a command ends with: "<job-id>: <stage>", or "<job-id>: queued".
interface Outcome {
  id: string;
  stage: string;
}

// Starts a job under a chosen id: runJob in-process, or enqueueJob with DATABASE_URL. push is the remote of run --push.
type Start = (input: { id: string; feature: string; push?: string }) => Promise<Outcome>;

const USAGE = [
  "Usage: fabrica <command>",
  "",
  "Commands:",
  "  run [--push <remote>] <feature...>  create a job for a feature and run it (queue it when DATABASE_URL is set);",
  "                                      with --push, push factory/<job-id> to the remote instead of merging",
  "  next                                claim the first unchecked item of factory/backlog.md and run it (or queue it)",
  "  approve <job-id>                    merge a needs-human job (or push it, for a job run with --push)",
  "  rework <job-id> <note...>           restart a needs-human job with a note for a fresh builder",
  "  status                              list the jobs in factory/jobs/",
  "  worker                              run queued jobs for this repo until stopped (needs DATABASE_URL)",
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
    case "run": {
      // --push <remote> is only an option right after run: the feature is free text that may contain it.
      const push = args[0] === "--push" ? args[1] : undefined;
      const feature = args[0] === "--push" ? args.slice(2).join(" ") : text;
      if (feature.trim() === "" || push?.trim() === "") return usage();
      return withRepo(deps, (options) =>
        starting(options, deps, (start) =>
          runFeature(options, feature, push === undefined ? start : (input) => start({ ...input, push })),
        ),
      );
    }
    case "next":
      if (args.length > 0) return usage();
      return withRepo(deps, (options) => starting(options, deps, (start) => next(options, deps, start)));
    case "approve": {
      if (args.length !== 1) return usage();
      const id = args[0]!;
      if (!validId(id, deps)) return 1;
      return withRepo(deps, (options) => withJobStore(options, deps, (stored) => approveJob(stored, id)));
    }
    case "rework": {
      const [id, ...words] = args;
      const note = words.join(" ");
      if (id === undefined || note.trim() === "") return usage();
      if (!validId(id, deps)) return 1;
      return withRepo(deps, (options) => withJobStore(options, deps, (stored) => reworkJob(stored, id, note)));
    }
    case "status":
      if (args.length > 0) return usage();
      return withRepo(deps, async (options) => {
        await status(options.repo, deps);
        return null;
      });
    case "worker": {
      if (args.length > 0) return usage();
      const { databaseUrl } = deps;
      if (databaseUrl === undefined) {
        deps.err("fabrica: worker needs DATABASE_URL");
        return 1;
      }
      return withRepo(deps, (options) => work(options, databaseUrl, deps.signal));
    }
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
async function withRepo(deps: CliDeps, command: (options: RunnerOptions) => Promise<Outcome | null>): Promise<number> {
  const repo = await toplevel(deps.cwd);
  if (repo === null) {
    deps.err("fabrica: not inside a git repository");
    return 1;
  }
  const options: RunnerOptions = { repo, executor: deps.executor, notify: (message) => deps.out(message) };
  const teardown = deps.teardown;
  if (teardown !== undefined) options.teardown = (id) => teardown(repo, id);
  if (deps.hardenGit) options.hardenGit = true;
  if (deps.runSetup !== undefined) options.runSetup = deps.runSetup;
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

// Hands run and next a Start: runJob in-process, or, with DATABASE_URL, enqueueJob on this repo's queue and the job store.
async function starting(
  options: RunnerOptions,
  deps: CliDeps,
  command: (start: Start) => Promise<Outcome | null>,
): Promise<Outcome | null> {
  const { databaseUrl } = deps;
  if (databaseUrl === undefined) return command((input) => runJob(options, input));
  return withStore(databaseUrl, async (store) => {
    const queue = await openQueue({ databaseUrl }, options.repo, options.notify);
    try {
      return await command(async (input) => {
        const job = await enqueueJob({ ...options, store }, queue, input);
        return { id: job.id, stage: "queued" };
      });
    } finally {
      await queue.close();
    }
  });
}

// approve and rework run in-process either way. With DATABASE_URL they also keep the job's row and builder session in step.
function withJobStore(
  options: RunnerOptions,
  deps: CliDeps,
  command: (options: RunnerOptions) => Promise<JobState>,
): Promise<JobState> {
  if (deps.databaseUrl === undefined) return command(options);
  return withStore(deps.databaseUrl, (store) => command({ ...options, store }));
}

async function withStore<T>(databaseUrl: string, command: (store: JobStore) => Promise<T>): Promise<T> {
  const store = await openJobStore(databaseUrl);
  try {
    return await command(store);
  } finally {
    await store.close();
  }
}

// Runs this repo's queue worker until signal aborts, then stops it gracefully.
async function work(options: RunnerOptions, databaseUrl: string, signal: AbortSignal | undefined): Promise<null> {
  return withStore(databaseUrl, async (store) => {
    const worker = await startWorker({ ...options, store }, { databaseUrl });
    await new Promise<void>((done) => {
      if (signal?.aborted) done();
      else signal?.addEventListener("abort", () => done(), { once: true });
    });
    await worker.stop();
    return null;
  });
}

// Creates the job under the next free number, picking the next one again when another session took the folder.
// beforeAttempt runs with each chosen id just before start.
async function runFeature(
  options: RunnerOptions,
  feature: string,
  start: Start,
  beforeAttempt?: (id: string) => Promise<void>,
): Promise<Outcome> {
  for (;;) {
    const id = `${nextJobNumber(await jobEntries(options.repo))}-${slug(feature)}`;
    await beforeAttempt?.(id);
    try {
      return await start({ id, feature });
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

async function next(options: RunnerOptions, deps: CliDeps, start: Start): Promise<Outcome | null> {
  const file = join(options.repo, "factory", "backlog.md");
  const item = await claim(file);
  if (item === null) {
    deps.out("No unchecked items in factory/backlog.md.");
    return null;
  }
  let line = `- [x] ${item} → claimed`;
  return runFeature(options, item, start, async (id) => {
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
