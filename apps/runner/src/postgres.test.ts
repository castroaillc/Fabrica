// Runs against a real Postgres only when DATABASE_URL points at this machine; skipped otherwise, never failed.
// Each run uses its own pair of schemas and drops them afterwards.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { REVIEWERS, builderName, resumeMessage } from "@fabrica/core";
import type { JobState, OrchestratorState } from "@fabrica/core";
import type { AgentCall, AgentExecutor } from "./executor.js";
import { openQueue, startWorker } from "./queue.js";
import type { Worker } from "./queue.js";
import { enqueueJob } from "./runner.js";
import { openJobStore } from "./store.js";
import type { PostgresJobStore } from "./store.js";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

// Only a TCP URL to a local host counts: a host query parameter or a socket path could point elsewhere.
function localUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("host") || parsed.searchParams.has("hostaddr")) return undefined;
    return LOCAL_HOSTS.includes(parsed.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

const DATABASE_URL = localUrl(process.env.DATABASE_URL);
const SUFFIX = randomBytes(4).toString("hex");
const QUEUE_SCHEMA = `fabrica_test_${SUFFIX}_queue`;
const RUNNER_SCHEMA = `fabrica_test_${SUFFIX}_runner`;
const ID = "001-x";
const AGENTS = ["spec-writer", "builder", ...REVIEWERS.map((r) => `reviewer-${r}`), "approver"];

const temps: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  if (DATABASE_URL === undefined) return;
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${QUEUE_SCHEMA} CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS ${RUNNER_SCHEMA} CASCADE`);
  } finally {
    await pool.end();
  }
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-pg-")));
  temps.push(root);
  const repo = join(root, "app");
  mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  for (const name of AGENTS) {
    const agent = `---\nname: ${name}\ndescription: Fixture ${name}.\ntools: Read, Write\nmodel: opus\n---\n\nFixture.\n`;
    writeFileSync(join(repo, ".claude", "agents", `${name}.md`), agent);
  }
  writeFileSync(join(repo, ".gitignore"), "/factory/jobs/\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "Initial");
  return repo;
}

// Writes each agent's file into the job folder; reviewers say CHANGES when changes(reviewer, round) is true.
// hang(call) true makes that call never settle, as if the runner died during it.
function fake(
  repo: string,
  script: { changes?: (reviewer: string, round: number) => boolean; hang?: (call: AgentCall) => boolean } = {},
): { executor: AgentExecutor; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  const folder = join(repo, "factory", "jobs", ID);
  const executor: AgentExecutor = async (call) => {
    calls.push(call);
    if (script.hang?.(call)) await new Promise<void>(() => {});
    const name = call.agent.name;
    if (name === "spec-writer") writeFileSync(join(folder, "spec.md"), "# Spec\n");
    if (name === "builder") {
      const file = `file-${calls.length}.txt`;
      writeFileSync(join(call.cwd, file), "build\n");
      sh(call.cwd, "add", file);
      sh(call.cwd, "commit", "-q", "-m", `Build ${calls.length}`);
      writeFileSync(join(folder, "build.md"), "STATUS: READY\n");
    }
    if (name.startsWith("reviewer-")) {
      const reviewer = name.slice("reviewer-".length);
      const round = Number(call.prompt.match(/Review round (\d+)\./)?.[1]);
      const verdict = script.changes?.(reviewer, round) ? "CHANGES" : "PASS";
      writeFileSync(join(folder, `round-${round}`, `review-${reviewer}.md`), `VERDICT: ${verdict}\n`);
    }
    if (name === "approver") writeFileSync(join(folder, "decision.md"), "APPROVE\n");
    return { sessionId: `session-${calls.length}` };
  };
  return { executor, calls };
}

async function store(): Promise<PostgresJobStore> {
  const opened = await openJobStore(DATABASE_URL!, RUNNER_SCHEMA);
  closers.push(() => opened.close());
  return opened;
}

async function worker(start: () => Promise<Worker>): Promise<Worker> {
  const started = await start();
  closers.push(() => started.stop());
  return started;
}

async function enqueue(repo: string, jobs: PostgresJobStore, notes: string[]): Promise<void> {
  const queue = await openQueue({ databaseUrl: DATABASE_URL!, schema: QUEUE_SCHEMA }, repo, (m) => notes.push(m));
  try {
    await enqueueJob({ repo, executor: fake(repo).executor, notify: (m) => notes.push(m), store: jobs }, queue, {
      id: ID,
      feature: "Do X",
    });
  } finally {
    await queue.close();
  }
}

function readJob(repo: string): JobState {
  return JSON.parse(readFileSync(join(repo, "factory", "jobs", ID, "job.json"), "utf8")) as JobState;
}

async function until(check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((done) => setTimeout(done, 100));
  }
}

describe.skipIf(DATABASE_URL === undefined)("Postgres job store and queue", () => {
  it("round-trips a row, keeps sessions across saves, and lives in its own schema", async () => {
    const jobs = await store();
    const repo = "/tmp/some-repo";
    const job: JobState = {
      id: ID,
      feature: "Do X",
      branch: `factory/${ID}`,
      worktree: `/tmp/some-repo-factory/${ID}`,
      stage: "spec",
      round: 0,
      reviews: { security: "pending", ux: "pending", ui: "pending", code: "pending" },
    };
    const state: OrchestratorState = { repo, job, resumes: 0, awaiting: "worktree" };
    const inFlight = [{ type: "createWorktree" as const, branch: job.branch, worktree: job.worktree }];

    expect(await jobs.load(repo, ID)).toBeNull();
    await expect(jobs.saveSession(repo, ID, builderName(ID), "s-0")).rejects.toThrow(/no saved job/);
    await jobs.save(repo, ID, { feature: "Do X", state, inFlight });
    expect(await jobs.load(repo, ID)).toEqual({ feature: "Do X", state, inFlight, sessions: {} });
    await jobs.saveSession(repo, ID, builderName(ID), "s-1");
    const building: OrchestratorState = { ...state, job: { ...job, stage: "build" }, awaiting: "builder" };
    await jobs.save(repo, ID, { feature: "Do X", state: building, inFlight: [] });
    expect(await jobs.load(repo, ID)).toEqual({
      feature: "Do X",
      state: building,
      inFlight: [],
      sessions: { [builderName(ID)]: "s-1" },
    });
    expect(await jobs.load("/tmp/other-repo", ID)).toBeNull();

    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
      const { rows } = await pool.query<{ table_schema: string }>(
        "SELECT table_schema FROM information_schema.tables WHERE table_name = 'jobs' AND table_schema = $1",
        [RUNNER_SCHEMA],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await pool.end();
    }
    await expect(openJobStore(DATABASE_URL!, "public; DROP")).rejects.toThrow(/Invalid schema name/);
  });

  it("runs a job enqueued while no worker was running once a worker starts", async () => {
    const repo = makeRepo();
    const jobs = await store();
    const notes: string[] = [];
    await enqueue(repo, jobs, notes);
    expect(readJob(repo).stage).toBe("spec");
    expect((await jobs.load(repo, ID))?.state.awaiting).toBe("worktree");

    const { executor, calls } = fake(repo);
    const options = { repo, executor, notify: (m: string) => notes.push(m), store: jobs };
    await worker(() => startWorker(options, { databaseUrl: DATABASE_URL!, schema: QUEUE_SCHEMA }));
    await until(() => readJob(repo).stage === "merged");
    expect(calls.map((c) => c.agent.name).sort()).toEqual([...AGENTS].sort());
    await until(async () => (await jobs.load(repo, ID))?.state.awaiting === "nothing");
    expect(sh(repo, "log", "-1", "--format=%s", "main").trim()).toBe(`Merge factory/${ID}`);
  }, 60_000);

  it("lets a second worker finish a job whose worker died, resuming the persisted builder session", async () => {
    const repo = makeRepo();
    const jobs = await store();
    const notes: string[] = [];
    await enqueue(repo, jobs, notes);
    const config = { databaseUrl: DATABASE_URL!, schema: QUEUE_SCHEMA, heartbeatSeconds: 10 };

    // The first worker dies while the builder is resumed after round 1's CHANGES.
    const first = fake(repo, {
      changes: (reviewer, round) => reviewer === "code" && round === 1,
      hang: (call) => call.resume !== undefined,
    });
    const dying = await startWorker({ repo, executor: first.executor, notify: (m) => notes.push(m), store: jobs }, config);
    await until(() => first.calls.some((c) => c.resume !== undefined));
    await until(async () => (await jobs.load(repo, ID))?.inFlight[0]?.type === "resumeBuilder");
    const session = (await jobs.load(repo, ID))?.sessions[builderName(ID)];
    expect(session).toBe(`session-${first.calls.findIndex((c) => c.agent.name === "builder") + 1}`);
    await dying.stop({ graceful: false });

    const second = fake(repo);
    const options = { repo, executor: second.executor, notify: (m: string) => notes.push(m), store: jobs };
    await worker(() => startWorker(options, config));
    await until(() => readJob(repo).stage === "merged");
    expect(second.calls[0]?.agent.name).toBe("builder");
    expect(second.calls[0]?.resume).toBe(session);
    expect(second.calls[0]?.prompt).toBe(resumeMessage(ID, 1));
    expect(second.calls.some((c) => c.agent.name === "spec-writer")).toBe(false);
    expect(readJob(repo).round).toBe(2);
  }, 90_000);
});

describe("the Postgres test guard", () => {
  it("only accepts TCP URLs to localhost, 127.0.0.1 or ::1", () => {
    expect(localUrl("postgres://fabrica:fabrica@127.0.0.1:5432/fabrica")).toBeDefined();
    expect(localUrl("postgres://u:p@localhost/x")).toBeDefined();
    expect(localUrl("postgres://u:p@[::1]:5432/x")).toBeDefined();
    expect(localUrl("postgres://user:pw@db.example.com:5432/x")).toBeUndefined();
    expect(localUrl("postgres://u:p@localhost/x?host=db.example.com")).toBeUndefined();
    expect(localUrl("postgres:///x?host=/var/run/postgresql")).toBeUndefined();
    expect(localUrl("not a url")).toBeUndefined();
    expect(localUrl(undefined)).toBeUndefined();
  });
});
