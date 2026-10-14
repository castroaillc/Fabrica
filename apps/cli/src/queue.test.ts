import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEWERS, builderName } from "@fabrica/core";
import type { JobState } from "@fabrica/core";
import { openJobStore, openQueue, startWorker } from "@fabrica/runner";
import type { AgentCall, AgentExecutor, JobMessage, PostgresJobStore, RunnerOptions, SavedJob } from "@fabrica/runner";
import { main } from "./main.js";

// The Postgres seams are replaced by in-memory fakes; everything else in @fabrica/runner is the real code.
vi.mock("@fabrica/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fabrica/runner")>();
  return { ...actual, openJobStore: vi.fn(), openQueue: vi.fn(), startWorker: vi.fn() };
});

const AGENTS = ["spec-writer", "builder", ...REVIEWERS.map((r) => `reviewer-${r}`), "approver"];
const DATABASE_URL = "postgres://fabrica:fabrica@127.0.0.1:5432/fabrica";

const temps: string[] = [];
let rows: Map<string, SavedJob>;
let sent: JobMessage[];
let closed: string[];

beforeEach(() => {
  rows = new Map();
  sent = [];
  closed = [];
  vi.mocked(openJobStore).mockImplementation(async () => memoryStore());
  vi.mocked(openQueue).mockImplementation(async () => ({
    send: async (message) => void sent.push(message),
    close: async () => void closed.push("queue"),
  }));
});

afterEach(() => {
  vi.mocked(openJobStore).mockReset();
  vi.mocked(openQueue).mockReset();
  vi.mocked(startWorker).mockReset();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryStore(): PostgresJobStore {
  const key = (repo: string, id: string) => `${repo}\n${id}`;
  return {
    async load(repo, id) {
      return rows.get(key(repo, id)) ?? null;
    },
    async save(repo, id, saved) {
      rows.set(key(repo, id), JSON.parse(JSON.stringify({ ...saved, sessions: rows.get(key(repo, id))?.sessions ?? {} })));
    },
    async saveSession(repo, id, name, sessionId) {
      const row = rows.get(key(repo, id));
      if (row === undefined) throw new Error(`no row for ${id}`);
      row.sessions[name] = sessionId;
    },
    async close() {
      closed.push("store");
    },
  };
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function agentFile(name: string): string {
  return `---\nname: ${name}\ndescription: Fixture ${name}.\ntools: Read, Write\nmodel: opus\n---\n\nYou are the ${name} fixture.\n`;
}

// A temp repo on main with fixture agents, a gitignored factory/jobs/ and a tracked backlog.
function makeRepo(backlog = "# Backlog\n"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-cli-queue-")));
  temps.push(root);
  const repo = join(root, "app");
  mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
  mkdirSync(join(repo, "factory"));
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  for (const name of AGENTS) writeFileSync(join(repo, ".claude", "agents", `${name}.md`), agentFile(name));
  writeFileSync(join(repo, ".gitignore"), "/factory/jobs/\n");
  writeFileSync(join(repo, "factory", "backlog.md"), backlog);
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "Initial");
  return repo;
}

function readJob(repo: string, id: string): JobState {
  return JSON.parse(readFileSync(join(repo, "factory", "jobs", id, "job.json"), "utf8")) as JobState;
}

function recorder(): { executor: AgentExecutor; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  return { calls, executor: async (call) => (calls.push(call), { sessionId: "s" }) };
}

async function cli(argv: string[], cwd: string, extra: { databaseUrl?: string; signal?: AbortSignal } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const { executor, calls } = recorder();
  const code = await main(argv, { cwd, executor, out: (l) => out.push(l), err: (l) => err.push(l), ...extra });
  return { code, out, err, calls };
}

describe("run and next with DATABASE_URL", () => {
  it("run enqueues the job, prints <id>: queued and spawns no agent", async () => {
    const repo = makeRepo();
    const { code, out, err, calls } = await cli(["run", "hello", "world"], repo, { databaseUrl: DATABASE_URL });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out).toEqual(["001-hello-world: queued"]);
    expect(calls).toHaveLength(0);
    expect(readJob(repo, "001-hello-world")).toMatchObject({ stage: "spec", round: 0, feature: "hello world" });
    expect(sent).toEqual([{ repo, id: "001-hello-world" }]);
    expect(rows.get(`${repo}\n001-hello-world`)?.state.awaiting).toBe("worktree");
    expect(vi.mocked(openJobStore)).toHaveBeenCalledWith(DATABASE_URL);
    expect(vi.mocked(openQueue).mock.calls[0]?.slice(0, 2)).toEqual([{ databaseUrl: DATABASE_URL }, repo]);
    expect(closed.sort()).toEqual(["queue", "store"]);
    expect(sh(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("run --push stores the remote in job.json and the saved row", async () => {
    const repo = makeRepo();
    execFileSync("git", ["init", "-q", "--bare", join(repo, "..", "remote.git")]);
    sh(repo, "remote", "add", "origin", join(repo, "..", "remote.git"));
    const { code, out, err } = await cli(["run", "--push", "origin", "hello"], repo, { databaseUrl: DATABASE_URL });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out).toEqual(["001-hello: queued"]);
    expect(readJob(repo, "001-hello")).toMatchObject({ stage: "spec", feature: "hello", push: "origin" });
    expect(rows.get(`${repo}\n001-hello`)?.state.job.push).toBe("origin");
  });

  it("run --push with an unknown remote enqueues nothing", async () => {
    const repo = makeRepo();
    const { code, out, err } = await cli(["run", "--push", "nosuch", "hello"], repo, { databaseUrl: DATABASE_URL });
    expect({ code, out, err }).toEqual({ code: 1, out: [], err: ["fabrica: no remote named nosuch"] });
    expect(sent).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it("run picks the next number when the folder is taken", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "factory", "jobs", "001-x"), { recursive: true });
    const { code, out } = await cli(["run", "Second"], repo, { databaseUrl: DATABASE_URL });
    expect(code).toBe(0);
    expect(out).toEqual(["002-second: queued"]);
  });

  it("next claims the backlog line, marks it with the id and enqueues it", async () => {
    const repo = makeRepo("# Backlog\n\n- [ ] Add a 404 page\n- [ ] Second item\n");
    const { code, out, calls } = await cli(["next"], repo, { databaseUrl: DATABASE_URL });
    expect(code).toBe(0);
    expect(out).toEqual(["001-add-a-404-page: queued"]);
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(repo, "factory", "backlog.md"), "utf8")).toBe(
      "# Backlog\n\n- [x] Add a 404 page → 001-add-a-404-page\n- [ ] Second item\n",
    );
    expect(sent).toEqual([{ repo, id: "001-add-a-404-page" }]);
  });

  it("without DATABASE_URL opens no store or queue", async () => {
    const repo = makeRepo();
    await cli(["status"], repo);
    await cli(["next"], repo);
    expect(vi.mocked(openJobStore)).not.toHaveBeenCalled();
    expect(vi.mocked(openQueue)).not.toHaveBeenCalled();
  });
});

describe("rework with DATABASE_URL", () => {
  it("runs in-process and keeps the job's row and builder session in step", async () => {
    const repo = makeRepo();
    const job = {
      id: "001-x",
      feature: "X",
      branch: "factory/001-x",
      worktree: join(repo, "..", "app-factory", "001-x"),
      stage: "needs-human",
      round: 1,
      reviews: { security: "PASS", ux: "PASS", ui: "PASS", code: "PASS" },
    };
    mkdirSync(join(repo, "factory", "jobs", "001-x"), { recursive: true });
    writeFileSync(join(repo, "factory", "jobs", "001-x", "job.json"), JSON.stringify(job));
    sh(repo, "worktree", "add", "-q", "-b", job.branch, job.worktree, "main");
    // The recorder writes no build.md, so the run stops after the builder; the row still follows it.
    const { code, out, calls } = await cli(["rework", "001-x", "note"], repo, { databaseUrl: DATABASE_URL });
    expect(code).toBe(0);
    expect(calls.map((c) => c.agent.name)).toEqual(["builder"]);
    expect(out.at(-1)).toBe("001-x: build");
    const row = rows.get(`${repo}\n001-x`);
    expect(row?.state.job.stage).toBe("build");
    expect(row?.sessions).toEqual({ [builderName("001-x")]: "s" });
    expect(closed).toEqual(["store"]);
  });
});

describe("worker", () => {
  it("needs DATABASE_URL", async () => {
    const repo = makeRepo();
    expect(await cli(["worker"], repo)).toMatchObject({ code: 1, out: [], err: ["fabrica: worker needs DATABASE_URL"] });
    expect(vi.mocked(startWorker)).not.toHaveBeenCalled();
  });

  it("takes no arguments", async () => {
    const repo = makeRepo();
    const { code, err } = await cli(["worker", "extra"], repo, { databaseUrl: DATABASE_URL });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("  worker");
  });

  it("runs the repo's worker with the store until the signal aborts, then stops it", async () => {
    const repo = makeRepo();
    const stop = vi.fn(async () => undefined);
    let started: RunnerOptions | undefined;
    vi.mocked(startWorker).mockImplementation(async (options) => {
      started = options;
      options.notify("001-x: worktree ready → writing spec");
      return { stop };
    });
    const controller = new AbortController();
    const running = cli(["worker"], repo, { databaseUrl: DATABASE_URL, signal: controller.signal });
    await vi.waitFor(() => expect(started).toBeDefined());
    expect(started?.repo).toBe(repo);
    expect(started?.store).toBeDefined();
    expect(vi.mocked(startWorker).mock.calls[0]?.[1]).toEqual({ databaseUrl: DATABASE_URL });
    expect(stop).not.toHaveBeenCalled();
    controller.abort();
    const { code, out, err } = await running;
    expect({ code, out, err }).toEqual({ code: 0, out: ["001-x: worktree ready → writing spec"], err: [] });
    expect(stop).toHaveBeenCalledOnce();
    expect(closed).toEqual(["store"]);
  });
});
