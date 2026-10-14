import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REVIEWERS, parseAgentFile, resumeMessage, reworkPrompt } from "@fabrica/core";
import type { JobState, Reviewer, Verdict } from "@fabrica/core";
import type { AgentCall, AgentExecutor } from "./executor.js";
import { isValidJobId } from "./jobFolder.js";
import { approveJob, reworkJob, runJob } from "./runner.js";
import type { RunnerOptions } from "./runner.js";

const ID = "003-x";
const AGENTS = ["spec-writer", "builder", ...REVIEWERS.map((r) => `reviewer-${r}`), "approver"];

const temps: string[] = [];
// Fake builders commit file-<n>.txt with n unique across the file, so a rework's builder has something new to commit.
let commits = 0;
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fails(cwd: string, ...args: string[]): boolean {
  try {
    sh(cwd, ...args);
    return false;
  } catch {
    return true;
  }
}

function agentFile(name: string): string {
  const tools = name === "builder" ? "Read, Grep, Glob, Bash, Edit, Write" : "Read, Grep, Glob, Bash, Write";
  const model = name.startsWith("reviewer-") ? "sonnet" : "opus";
  return `---\nname: ${name}\ndescription: Fixture ${name}.\ntools: ${tools}\nmodel: ${model}\n---\n\nYou are the ${name} fixture.\n`;
}

// A temp repo on main with fixture agents, a gitignored factory/jobs/ and a tracked backlog.
function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-runner-")));
  temps.push(root);
  const repo = join(root, "app");
  mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
  mkdirSync(join(repo, "factory"));
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  for (const name of AGENTS) writeFileSync(join(repo, ".claude", "agents", `${name}.md`), agentFile(name));
  writeFileSync(join(repo, ".gitignore"), "/factory/jobs/\n");
  writeFileSync(join(repo, "factory", "backlog.md"), "# Backlog\n");
  writeFileSync(join(repo, "README.md"), "hello\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "Initial");
  return repo;
}

function folder(repo: string): string {
  return join(repo, "factory", "jobs", ID);
}

function readJob(repo: string): JobState {
  return JSON.parse(readFileSync(join(folder(repo), "job.json"), "utf8")) as JobState;
}

interface Script {
  build?: (call: AgentCall, n: number) => string;
  review?: (reviewer: Reviewer, round: number, call: AgentCall) => Verdict | null | Promise<Verdict | null>;
  decision?: (call: AgentCall) => string;
  hold?: (call: AgentCall) => Promise<void>;
}

// A fake executor that writes each agent's fixed file into the job folder and records every call.
function fake(repo: string, script: Script = {}): { executor: AgentExecutor; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  let sessions = 0;
  let builds = 0;
  const executor: AgentExecutor = async (call) => {
    calls.push(call);
    const jobs = folder(repo);
    const name = call.agent.name;
    await script.hold?.(call);
    if (name === "spec-writer") writeFileSync(join(jobs, "spec.md"), "# Spec\n");
    if (name === "builder") {
      builds += 1;
      commits += 1;
      writeFileSync(join(call.cwd, `file-${commits}.txt`), `build ${builds}\n`);
      sh(call.cwd, "add", `file-${commits}.txt`);
      sh(call.cwd, "commit", "-q", "-m", `Build ${builds}`);
      writeFileSync(join(jobs, "build.md"), script.build?.(call, builds) ?? "STATUS: READY\n\n# Build\n");
    }
    if (name.startsWith("reviewer-")) {
      const reviewer = name.slice("reviewer-".length) as Reviewer;
      const round = Number(call.prompt.match(/Review round (\d+)\./)?.[1]);
      const verdict = script.review ? await script.review(reviewer, round, call) : "PASS";
      if (verdict !== null) writeFileSync(join(jobs, `round-${round}`, `review-${reviewer}.md`), `VERDICT: ${verdict}\n`);
    }
    if (name === "approver") writeFileSync(join(jobs, "decision.md"), script.decision?.(call) ?? "APPROVE\n");
    sessions += 1;
    return { sessionId: `session-${sessions}` };
  };
  return { executor, calls };
}

function options(repo: string, executor: AgentExecutor, extra: Partial<RunnerOptions> = {}) {
  const notes: string[] = [];
  return { notes, options: { repo, executor, notify: (m: string) => notes.push(m), ...extra } };
}

function worktreeOf(repo: string): string {
  return join(dirname(repo), "app-factory", ID);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("isValidJobId", () => {
  it("accepts NNN-slug ids and rejects everything else", () => {
    expect(isValidJobId("003-local-runner")).toBe(true);
    expect(isValidJobId("001-a")).toBe(true);
    for (const id of ["3-x", "0003-x", "003-", "003-X", "003-a--b", "003-a-", "../003-x", "003-x/..", "003-x\n"]) {
      expect(isValidJobId(id), id).toBe(false);
    }
  });

  it("rejects an invalid id in every entry point before touching the filesystem or git", async () => {
    const repo = makeRepo();
    const { executor, calls } = fake(repo);
    const { options: opts } = options(repo, executor);
    await expect(runJob(opts, { id: "../003-x", feature: "X" })).rejects.toThrow(/Invalid job id/);
    await expect(approveJob(opts, "../003-x")).rejects.toThrow(/Invalid job id/);
    await expect(reworkJob(opts, "../003-x", "note")).rejects.toThrow(/Invalid job id/);
    expect(existsSync(join(repo, "factory", "jobs"))).toBe(false);
    expect(sh(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});

describe("runJob", () => {
  it("runs the happy path to a merge and cleans up", async () => {
    const repo = makeRepo();
    const { executor, calls } = fake(repo);
    const { options: opts } = options(repo, executor);
    const job = await runJob(opts, { id: ID, feature: "Do X" });

    expect(job.stage).toBe("merged");
    expect(job.round).toBe(1);
    expect(Object.values(job.reviews)).toEqual(["PASS", "PASS", "PASS", "PASS"]);
    expect(readJob(repo)).toEqual(job);
    expect(sh(repo, "log", "-1", "--format=%s", "main").trim()).toBe(`Merge factory/${ID}`);
    expect(sh(repo, "log", "-1", "--format=%s", "main^2").trim()).toBe("Build 1");
    expect(existsSync(worktreeOf(repo))).toBe(false);
    expect(sh(repo, "branch", "--list", `factory/${ID}`)).toBe("");
    expect(calls.map((c) => c.agent.name).sort()).toEqual([...AGENTS].sort());
  });

  it("writes job.json with exactly the JobState keys", async () => {
    const repo = makeRepo();
    const { executor } = fake(repo);
    await runJob(options(repo, executor).options, { id: ID, feature: "Do X" });
    const text = readFileSync(join(folder(repo), "job.json"), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    const job = JSON.parse(text) as JobState;
    expect(Object.keys(job)).toEqual(["id", "feature", "branch", "worktree", "stage", "round", "reviews"]);
    expect(text).toBe(`${JSON.stringify(job, null, 2)}\n`);
  });

  it("lands each verdict in job.json as soon as its reviewer finishes", async () => {
    const repo = makeRepo();
    const seen: number[] = [];
    const finished = () => Object.values(readJob(repo).reviews).filter((v) => v !== "pending").length;
    const { executor } = fake(repo, {
      // Reviewer i finishes only once the i reviewers before it are in job.json.
      review: async (reviewer) => {
        const i = REVIEWERS.indexOf(reviewer);
        for (let tries = 0; finished() < i && tries < 400; tries++) await sleep(5);
        seen.push(finished());
        return "PASS" as const;
      },
    });
    const job = await runJob(options(repo, executor).options, { id: ID, feature: "Do X" });
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(job.stage).toBe("merged");
  });

  it("calls each agent with its parsed definition and the worktree as cwd", async () => {
    const repo = makeRepo();
    const { executor, calls } = fake(repo);
    await runJob(options(repo, executor).options, { id: ID, feature: "Do X" });
    expect(calls).toHaveLength(AGENTS.length);
    for (const call of calls) {
      const parsed = parseAgentFile(agentFile(call.agent.name));
      expect(call.agent).toEqual(parsed);
      expect(call.agent.prompt).toBe(`You are the ${call.agent.name} fixture.\n`);
      expect(call.agent.tools).toEqual(parsed.tools);
      expect(call.agent.model).toBe(parsed.model);
      expect(call.cwd).toBe(worktreeOf(repo));
      expect(call.resume).toBeUndefined();
    }
  });

  it("runs the four reviewers at the same time", async () => {
    const repo = makeRepo();
    let started = 0;
    let release: () => void = () => {};
    const allStarted = new Promise<void>((done) => (release = done));
    const { executor } = fake(repo, {
      hold: async (call) => {
        if (!call.agent.name.startsWith("reviewer-")) return;
        started += 1;
        if (started === 4) release();
        await allStarted;
      },
    });
    const job = await runJob(options(repo, executor).options, { id: ID, feature: "Do X" });
    expect(started).toBe(4);
    expect(job.stage).toBe("merged");
  }, 10_000);

  it("resumes the same builder session after a CHANGES round", async () => {
    const repo = makeRepo();
    const { executor, calls } = fake(repo, {
      review: (reviewer, round) => (round === 1 && reviewer === "code" ? "CHANGES" : "PASS"),
    });
    const job = await runJob(options(repo, executor).options, { id: ID, feature: "Do X" });
    const builders = calls.filter((c) => c.agent.name === "builder");
    expect(builders).toHaveLength(2);
    const first = calls.indexOf(builders[0]!);
    expect(builders[0]!.resume).toBeUndefined();
    expect(builders[1]!.resume).toBe(`session-${first + 1}`);
    expect(builders[1]!.prompt).toBe(resumeMessage(ID, 1));
    expect(existsSync(join(folder(repo), "round-2"))).toBe(true);
    expect(job.stage).toBe("merged");
    expect(job.round).toBe(2);
  });

  it("escalates when the review rounds are exhausted", async () => {
    const repo = makeRepo();
    const { executor, calls } = fake(repo, { review: (reviewer) => (reviewer === "ux" ? "CHANGES" : "PASS") });
    const job = await runJob(options(repo, executor).options, { id: ID, feature: "Do X" });
    expect(job.stage).toBe("needs-human");
    expect(job.round).toBe(3);
    expect(readFileSync(join(folder(repo), "decision.md"), "utf8").startsWith("ESCALATE")).toBe(true);
    expect(calls.filter((c) => c.agent.name === "builder" && c.resume !== undefined)).toHaveLength(2);
    expect(calls.some((c) => c.agent.name === "approver")).toBe(false);
    expect(existsSync(worktreeOf(repo))).toBe(true);
  });

  it("hands a BLOCKED build to a human", async () => {
    const repo = makeRepo();
    const blocked = "STATUS: BLOCKED\n\n## Blocked\nThe spec contradicts itself.\n";
    const { executor } = fake(repo, { build: () => blocked });
    const { options: opts, notes } = options(repo, executor);
    const job = await runJob(opts, { id: ID, feature: "Do X" });
    expect(job.stage).toBe("needs-human");
    expect(readJob(repo).stage).toBe("needs-human");
    expect(existsSync(worktreeOf(repo))).toBe(true);
    expect(sh(repo, "branch", "--list", `factory/${ID}`)).toContain(`factory/${ID}`);
    expect(notes.some((n) => n.includes(blocked))).toBe(true);
  });

  it("does not merge into a busy main checkout, then approveJob merges once it is clean", async () => {
    const repo = makeRepo();
    const head = sh(repo, "rev-parse", "main").trim();
    const { executor } = fake(repo, {
      decision: () => {
        writeFileSync(join(repo, "stray.txt"), "untracked\n");
        return "APPROVE\n";
      },
    });
    const { options: opts } = options(repo, executor);
    const job = await runJob(opts, { id: ID, feature: "Do X" });
    expect(job.stage).toBe("needs-human");
    expect(sh(repo, "rev-parse", "main").trim()).toBe(head);

    rmSync(join(repo, "stray.txt"));
    writeFileSync(join(repo, "factory", "backlog.md"), "# Backlog\n\n- edited\n");
    const approved = await approveJob(opts, ID);
    expect(approved.stage).toBe("merged");
    expect(readJob(repo).stage).toBe("merged");
    expect(sh(repo, "log", "-1", "--format=%s", "main").trim()).toBe(`Merge factory/${ID}`);
  });

  it("aborts a conflicting merge and hands the job to a human", async () => {
    const repo = makeRepo();
    let head = "";
    const { executor } = fake(repo, {
      build: (call) => {
        writeFileSync(join(call.cwd, "README.md"), "from the job\n");
        sh(call.cwd, "commit", "-q", "-am", "Job edit");
        writeFileSync(join(repo, "README.md"), "from main\n");
        sh(repo, "commit", "-q", "-am", "Main edit");
        head = sh(repo, "rev-parse", "main").trim();
        return "STATUS: READY\n";
      },
    });
    const job = await runJob(options(repo, executor).options, { id: ID, feature: "Do X" });
    expect(job.stage).toBe("needs-human");
    expect(fails(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toBe(true);
    expect(sh(repo, "rev-parse", "main").trim()).toBe(head);
  });

  it("stops on worktree setup failure without calling an agent", async () => {
    const repo = makeRepo();
    const { executor, calls } = fake(repo);
    const { options: opts, notes } = options(repo, executor, { setup: ["node", "-e", "process.exit(1)"] });
    const job = await runJob(opts, { id: ID, feature: "Do X" });
    expect(job.stage).toBe("spec");
    expect(readJob(repo).stage).toBe("spec");
    expect(calls).toHaveLength(0);
    expect(notes.some((n) => n.includes("worktree setup failed"))).toBe(true);
  });

  it("runs the setup command in the worktree", async () => {
    const repo = makeRepo();
    let ranInWorktree = false;
    const { executor } = fake(repo, {
      hold: async (call) => {
        ranInWorktree ||= existsSync(join(call.cwd, "setup-ran"));
      },
    });
    const setup = ["node", "-e", "require('node:fs').writeFileSync('setup-ran', '')"];
    const { options: opts, notes } = options(repo, executor, { setup });
    const job = await runJob(opts, { id: ID, feature: "Do X" });
    expect(ranInWorktree).toBe(true);
    // The untracked setup output makes git worktree remove fail; the job still counts as merged.
    expect(job.stage).toBe("merged");
    expect(notes.some((n) => n.includes("git worktree remove failed"))).toBe(true);
  });

  it("stops mid-round when a reviewer writes no file, and waits for the others", async () => {
    const repo = makeRepo();
    const finished: string[] = [];
    const { executor } = fake(repo, {
      review: async (reviewer) => {
        if (reviewer === "ux") return null;
        await sleep(50);
        finished.push(reviewer);
        return "PASS" as const;
      },
    });
    const { options: opts, notes } = options(repo, executor);
    const job = await runJob(opts, { id: ID, feature: "Do X" });
    expect(notes.some((n) => n.includes("reviewer-ux") && n.includes("round-1/review-ux.md"))).toBe(true);
    expect(job.stage).toBe("review");
    expect(job.reviews.ux).toBe("pending");
    expect(finished.sort()).toEqual(["code", "security", "ui"]);
  });

  it("refuses a job folder that already exists", async () => {
    const repo = makeRepo();
    mkdirSync(folder(repo), { recursive: true });
    const { executor, calls } = fake(repo);
    const error = await runJob(options(repo, executor).options, { id: ID, feature: "Do X" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`${ID}: job folder already exists: ${folder(repo)}`);
    expect((error as Error & { code?: string }).code).toBe("EEXIST");
    expect(calls).toHaveLength(0);
    expect(existsSync(worktreeOf(repo))).toBe(false);
  });

  it("notifies when the executor rejects and still reads the agent's file", async () => {
    const repo = makeRepo();
    const { executor } = fake(repo);
    const failing: AgentExecutor = async (call) => {
      const result = await executor(call);
      if (call.agent.name === "spec-writer") throw new Error("model overloaded");
      return result;
    };
    const { options: opts, notes } = options(repo, failing);
    const job = await runJob(opts, { id: ID, feature: "Do X" });
    expect(notes.some((n) => n.includes("spec-writer failed: model overloaded"))).toBe(true);
    expect(job.stage).toBe("merged");
  });
});

describe("reworkJob", () => {
  it("writes rework-1.md and starts a fresh builder that runs the loop to a merge", async () => {
    const repo = makeRepo();
    const first = fake(repo, { build: () => "STATUS: BLOCKED\n\nNeed a decision.\n" });
    const blocked = await runJob(options(repo, first.executor).options, { id: ID, feature: "Do X" });
    expect(blocked.stage).toBe("needs-human");

    const second = fake(repo);
    const job = await reworkJob(options(repo, second.executor).options, ID, "note");
    expect(readFileSync(join(folder(repo), "rework-1.md"), "utf8")).toContain("note");
    const builder = second.calls.find((c) => c.agent.name === "builder");
    expect(builder?.resume).toBeUndefined();
    expect(builder?.prompt).toBe(reworkPrompt(repo, blocked, 1));
    expect(job.stage).toBe("merged");
    expect(job.round).toBe(1);
  });

  it("throws when job.json has another id", async () => {
    const repo = makeRepo();
    const { executor } = fake(repo, { build: () => "STATUS: BLOCKED\n" });
    const blocked = await runJob(options(repo, executor).options, { id: ID, feature: "Do X" });
    writeFileSync(join(folder(repo), "job.json"), JSON.stringify({ ...blocked, id: "004-y" }));
    await expect(reworkJob(options(repo, executor).options, ID, "note")).rejects.toThrow(/has id/);
    await expect(approveJob(options(repo, executor).options, ID)).rejects.toThrow(/has id/);
    expect(existsSync(join(folder(repo), "rework-1.md"))).toBe(false);
  });

  it.each([
    ["branch", { branch: "main" }],
    ["branch", { branch: "--delete" }],
    ["worktree", { worktree: "/tmp/elsewhere" }],
    ["worktree", { worktree: "../app-factory/003-x" }],
    ["round", { round: -1 }],
    ["round", { round: 1.5 }],
    ["round", { round: "1" }],
    ["stage", { stage: "shipped" }],
  ])("rejects a job.json with a bad %s before touching git or agents", async (field, change) => {
    const repo = makeRepo();
    const first = fake(repo, { build: () => "STATUS: BLOCKED\n" });
    const blocked = await runJob(options(repo, first.executor).options, { id: ID, feature: "Do X" });
    const json = `${JSON.stringify({ ...blocked, ...change })}\n`;
    writeFileSync(join(folder(repo), "job.json"), json);
    const main = sh(repo, "rev-parse", "main");
    const { executor, calls } = fake(repo);
    const pattern = new RegExp(`has ${field} `);
    await expect(reworkJob(options(repo, executor).options, ID, "note")).rejects.toThrow(pattern);
    await expect(approveJob(options(repo, executor).options, ID)).rejects.toThrow(pattern);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(folder(repo), "rework-1.md"))).toBe(false);
    expect(readFileSync(join(folder(repo), "job.json"), "utf8")).toBe(json);
    expect(sh(repo, "rev-parse", "main")).toBe(main);
    expect(existsSync(worktreeOf(repo))).toBe(true);
  });
});
