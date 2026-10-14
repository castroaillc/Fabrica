import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REVIEWERS,
  builderName,
  parseAgentFile,
  parseFabricaConfig,
  resumeMessage,
  reworkPrompt,
} from "@fabrica/core";
import type { JobState, Reviewer, Verdict } from "@fabrica/core";
import type { AgentCall, AgentExecutor } from "./executor.js";
import { isValidJobId } from "./jobFolder.js";
import type { JobStore, SavedJob } from "./jobStore.js";
import type { JobMessage, JobQueue } from "./queue.js";
import { approveJob, enqueueJob, resumeJob, reworkJob, runJob } from "./runner.js";
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
      expect(call.jobId).toBe(ID);
      expect(call.jobFolder).toBe(folder(repo));
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

  it("calls teardown once, after the worktree is removed", async () => {
    const repo = makeRepo();
    const { executor } = fake(repo);
    const torn: { id: string; worktree: boolean }[] = [];
    const teardown = async (id: string) => {
      torn.push({ id, worktree: existsSync(worktreeOf(repo)) });
    };
    const job = await runJob(options(repo, executor, { teardown }).options, { id: ID, feature: "Do X" });
    expect(job.stage).toBe("merged");
    expect(torn).toEqual([{ id: ID, worktree: false }]);
  });

  it("reports a failing teardown through notify without changing the outcome", async () => {
    const repo = makeRepo();
    const { executor } = fake(repo);
    const teardown = async () => {
      throw new Error("docker rm failed");
    };
    const { options: opts, notes } = options(repo, executor, { teardown });
    const job = await runJob(opts, { id: ID, feature: "Do X" });
    expect(job.stage).toBe("merged");
    expect(notes).toContain(`${ID}: teardown failed: docker rm failed`);
  });

  it("turns off git hooks and fsmonitor for host git with hardenGit, and leaves them on without it", async () => {
    for (const hardenGit of [true, false]) {
      const repo = makeRepo();
      const marks = join(dirname(repo), "marks");
      // What a container agent could plant in the mounted git dir once it has committed: a hook and an fsmonitor.
      const script = (name: string) => {
        const file = join(repo, ".git", "hooks", name);
        writeFileSync(file, `#!/bin/sh\necho ${name} >> ${marks}\n`, { mode: 0o755 });
        return file;
      };
      const { executor } = fake(repo, {
        build: () => {
          script("post-merge");
          sh(repo, "config", "core.fsmonitor", script("fsmonitor"));
          return "STATUS: READY\n\n# Build\n";
        },
      });
      const extra = hardenGit ? { hardenGit } : {};
      const job = await runJob(options(repo, executor, extra).options, { id: ID, feature: "Do X" });
      expect(job.stage).toBe("merged");
      const ran = existsSync(marks) ? readFileSync(marks, "utf8") : "";
      if (hardenGit) expect(ran).toBe("");
      else for (const name of ["post-merge", "fsmonitor"]) expect(ran).toContain(name);
    }
  });

  it("runs no teardown in host mode, where there is no hook", async () => {
    const repo = makeRepo();
    const { executor } = fake(repo);
    const { options: opts, notes } = options(repo, executor);
    const job = await runJob(opts, { id: ID, feature: "Do X" });
    expect("teardown" in opts).toBe(false);
    expect(job.stage).toBe("merged");
    expect(notes.some((n) => n.includes("teardown"))).toBe(false);
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

describe("fabrica.yaml", () => {
  const CONFIG = `providers:
  claude-bedrock: { type: bedrock, region: us-east-1 }
  gateway: { type: anthropic-compatible, base_url: https://litellm:4000 }
roles:
  builder: { provider: claude-bedrock, model: claude-opus-5-5 }
  reviewer-ux: { provider: gateway }
`;

  function commitConfig(repo: string, content: string): void {
    writeFileSync(join(repo, "fabrica.yaml"), content);
    sh(repo, "add", "fabrica.yaml");
    sh(repo, "commit", "-q", "-m", "Add fabrica.yaml");
  }

  it("sets each configured role's provider and model on its calls, including the resumed builder", async () => {
    const repo = makeRepo();
    commitConfig(repo, CONFIG);
    const { executor, calls } = fake(repo, {
      review: (reviewer, round) => (round === 1 && reviewer === "code" ? "CHANGES" : "PASS"),
    });
    const job = await runJob(options(repo, executor).options, { id: ID, feature: "Do X" });
    expect(job.stage).toBe("merged");

    const builders = calls.filter((c) => c.agent.name === "builder");
    expect(builders).toHaveLength(2);
    expect(builders[1]!.resume).toBeDefined();
    for (const call of builders) {
      expect(call.provider).toEqual({ type: "bedrock", region: "us-east-1" });
      expect(call.model).toBe("claude-opus-5-5");
      expect(call.agent.model).toBe("opus");
    }
    const ux = calls.filter((c) => c.agent.name === "reviewer-ux");
    expect(ux).toHaveLength(2);
    for (const call of ux) {
      expect(call.provider).toEqual({ type: "anthropic-compatible", base_url: "https://litellm:4000" });
      expect("model" in call).toBe(false);
    }
    const others = calls.filter((c) => c.agent.name !== "builder" && c.agent.name !== "reviewer-ux");
    expect(others.map((c) => c.agent.name)).toContain("spec-writer");
    for (const call of others) {
      expect("provider" in call, call.agent.name).toBe(false);
      expect("model" in call, call.agent.name).toBe(false);
    }
  });

  it("ignores a fabrica.yaml that is only in the job worktree", async () => {
    const repo = makeRepo();
    const first = fake(repo, {
      build: (call) => {
        writeFileSync(join(call.cwd, "fabrica.yaml"), CONFIG);
        sh(call.cwd, "add", "fabrica.yaml");
        sh(call.cwd, "commit", "-q", "-m", "Add fabrica.yaml");
        return "STATUS: BLOCKED\n";
      },
    });
    const blocked = await runJob(options(repo, first.executor).options, { id: ID, feature: "Do X" });
    expect(blocked.stage).toBe("needs-human");
    expect(existsSync(join(worktreeOf(repo), "fabrica.yaml"))).toBe(true);
    expect(existsSync(join(repo, "fabrica.yaml"))).toBe(false);

    const second = fake(repo);
    await reworkJob(options(repo, second.executor).options, ID, "note");
    expect(second.calls.map((c) => c.agent.name)).toContain("builder");
    for (const call of [...first.calls, ...second.calls]) {
      expect("provider" in call, call.agent.name).toBe(false);
      expect("model" in call, call.agent.name).toBe(false);
    }
  });

  it("rejects a role naming no agent before running any action", async () => {
    const repo = makeRepo();
    commitConfig(repo, "providers:\n  api: { type: anthropic }\nroles:\n  reviewer-perf: { provider: api }\n");
    const { executor, calls } = fake(repo);
    await expect(runJob(options(repo, executor).options, { id: ID, feature: "Do X" })).rejects.toThrow(
      /reviewer-perf.*\.claude\/agents\//,
    );
    expect(calls).toHaveLength(0);
    expect(existsSync(folder(repo))).toBe(false);
    expect(existsSync(worktreeOf(repo))).toBe(false);
  });

  it("rejects an invalid fabrica.yaml with its path before running any action", async () => {
    const repo = makeRepo();
    commitConfig(repo, "providers:\n  p: { type: bedrock }\n");
    const { executor, calls } = fake(repo);
    const run = runJob(options(repo, executor).options, { id: ID, feature: "Do X" });
    await expect(run).rejects.toThrow(join(repo, "fabrica.yaml"));
    await expect(run).rejects.toThrow("providers.p.region");
    expect(calls).toHaveLength(0);
    expect(existsSync(folder(repo))).toBe(false);
  });

  it("ships a fabrica.example.yaml at the repo root that parses", () => {
    const content = readFileSync(new URL("../../../fabrica.example.yaml", import.meta.url), "utf8");
    const config = parseFabricaConfig(content);
    expect(Object.values(config.providers).map((p) => p.type).sort()).toEqual([
      "anthropic",
      "anthropic-compatible",
      "bedrock",
      "vertex",
    ]);
  });
});

// An in-memory JobStore. Rows go through JSON like Postgres jsonb, and each saveSession records the state it landed on.
function memoryStore(rows = new Map<string, SavedJob>()) {
  const key = (repo: string, id: string) => `${repo}\n${id}`;
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const sessionSaves: { name: string; sessionId: string; awaiting: string }[] = [];
  const store: JobStore = {
    async load(repo, id) {
      const row = rows.get(key(repo, id));
      return row === undefined ? null : copy(row);
    },
    async save(repo, id, saved) {
      rows.set(key(repo, id), copy({ ...saved, sessions: rows.get(key(repo, id))?.sessions ?? {} }));
    },
    async saveSession(repo, id, name, sessionId) {
      const row = rows.get(key(repo, id));
      if (row === undefined) throw new Error(`no row for ${id}`);
      row.sessions[name] = sessionId;
      sessionSaves.push({ name, sessionId, awaiting: row.state.awaiting });
    },
  };
  return { store, rows, sessionSaves, row: (repo: string) => rows.get(key(repo, ID)) };
}

function fakeQueue(): JobQueue & { sent: JobMessage[] } {
  const sent: JobMessage[] = [];
  return { sent, send: async (message) => void sent.push(message) };
}

const never = new Promise<void>(() => {});

// Waits until check passes, polling, so a test can look at the store while a "crashed" run hangs.
async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    if (tries > 400) throw new Error("timed out waiting");
    await sleep(5);
  }
}

describe("enqueueJob", () => {
  it("writes job.json and the saved row, and sends one message without running anything", async () => {
    const repo = makeRepo();
    const { store, row } = memoryStore();
    const queue = fakeQueue();
    const { executor, calls } = fake(repo);
    const job = await enqueueJob(options(repo, executor, { store }).options, queue, { id: ID, feature: "Do X" });

    expect(job.stage).toBe("spec");
    expect(readJob(repo)).toEqual(job);
    expect(readJob(repo)).toMatchObject({ stage: "spec", round: 0 });
    expect(Object.values(readJob(repo).reviews)).toEqual(["pending", "pending", "pending", "pending"]);
    expect(row(repo)).toEqual({
      feature: "Do X",
      state: { repo, job, resumes: 0, awaiting: "worktree" },
      inFlight: [{ type: "createWorktree", branch: `factory/${ID}`, worktree: worktreeOf(repo) }],
      sessions: {},
    });
    expect(queue.sent).toEqual([{ repo, id: ID }]);
    expect(calls).toHaveLength(0);
    expect(existsSync(worktreeOf(repo))).toBe(false);
  });

  it("refuses a job folder that already exists, without saving or sending", async () => {
    const repo = makeRepo();
    mkdirSync(folder(repo), { recursive: true });
    const { store, rows } = memoryStore();
    const queue = fakeQueue();
    const error = await enqueueJob(options(repo, fake(repo).executor, { store }).options, queue, {
      id: ID,
      feature: "Do X",
    }).catch((e: unknown) => e);
    expect((error as Error & { code?: string }).code).toBe("EEXIST");
    expect(rows.size).toBe(0);
    expect(queue.sent).toEqual([]);
  });
});

describe("resumeJob", () => {
  it("drives a freshly enqueued job to merged and keeps the row in step", async () => {
    const repo = makeRepo();
    const { store, row, sessionSaves } = memoryStore();
    await enqueueJob(options(repo, fake(repo).executor, { store }).options, fakeQueue(), { id: ID, feature: "Do X" });
    const { executor, calls } = fake(repo);
    const job = await resumeJob(options(repo, executor, { store }).options, ID);

    expect(job.stage).toBe("merged");
    expect(readJob(repo)).toEqual(job);
    expect(calls.map((c) => c.agent.name).sort()).toEqual([...AGENTS].sort());
    expect(sh(repo, "log", "-1", "--format=%s", "main").trim()).toBe(`Merge factory/${ID}`);
    expect(row(repo)?.state).toEqual({ repo, job, resumes: 0, awaiting: "nothing" });
    expect(row(repo)?.inFlight).toEqual([]);
    const builder = calls.findIndex((c) => c.agent.name === "builder");
    expect(row(repo)?.sessions).toEqual({ [builderName(ID)]: `session-${builder + 1}` });
    // The session id is saved before the builder's agentDone is applied.
    expect(sessionSaves).toEqual([{ name: builderName(ID), sessionId: `session-${builder + 1}`, awaiting: "builder" }]);
  });

  it("resumes the persisted builder session after a restart in round 2's build", async () => {
    const repo = makeRepo();
    const { store, rows, row } = memoryStore();
    await enqueueJob(options(repo, fake(repo).executor, { store }).options, fakeQueue(), { id: ID, feature: "Do X" });
    const first = fake(repo, {
      review: (reviewer, round) => (round === 1 && reviewer === "code" ? "CHANGES" : "PASS"),
      // The runner "dies" while the resumed builder runs: its call never settles.
      hold: (call) => (call.resume !== undefined ? never : Promise.resolve()),
    });
    void resumeJob(options(repo, first.executor, { store }).options, ID);
    await until(() => row(repo)?.inFlight[0]?.type === "resumeBuilder");
    const saved = row(repo)!;
    const session = saved.sessions[builderName(ID)];
    expect(session).toBe(`session-${first.calls.findIndex((c) => c.agent.name === "builder") + 1}`);
    expect(saved.state).toMatchObject({ awaiting: "builder", resumes: 1, job: { stage: "build", round: 1 } });
    expect(saved.inFlight).toEqual([{ type: "resumeBuilder", name: builderName(ID), message: resumeMessage(ID, 1) }]);

    // A new runner process: a fresh store client over the same rows.
    const second = fake(repo);
    const job = await resumeJob(options(repo, second.executor, { store: memoryStore(rows).store }).options, ID);
    expect(second.calls[0]?.agent.name).toBe("builder");
    expect(second.calls[0]?.resume).toBe(session);
    expect(second.calls[0]?.prompt).toBe(resumeMessage(ID, 1));
    expect(second.calls.filter((c) => c.agent.name === "spec-writer")).toHaveLength(0);
    expect(job.stage).toBe("merged");
    expect(job.round).toBe(2);
  });

  it("spawns only the reviewers still pending after a restart mid-round", async () => {
    const repo = makeRepo();
    const { store, rows, row } = memoryStore();
    await enqueueJob(options(repo, fake(repo).executor, { store }).options, fakeQueue(), { id: ID, feature: "Do X" });
    const hung = new Set(["reviewer-ux", "reviewer-code"]);
    const first = fake(repo, { hold: (call) => (hung.has(call.agent.name) ? never : Promise.resolve()) });
    void resumeJob(options(repo, first.executor, { store }).options, ID);
    await until(() => row(repo)?.state.job.reviews.ui === "PASS" && row(repo)?.state.job.reviews.security === "PASS");
    const saved = row(repo)!;
    expect(saved.state.awaiting).toBe("reviewers");
    expect(saved.inFlight.map((a) => (a.type === "spawnAgent" ? a.agent : a.type)).sort()).toEqual([
      "reviewer-code",
      "reviewer-ux",
    ]);

    const second = fake(repo);
    const job = await resumeJob(options(repo, second.executor, { store: memoryStore(rows).store }).options, ID);
    expect(second.calls.map((c) => c.agent.name)).toEqual(["reviewer-ux", "reviewer-code", "approver"]);
    expect(job.stage).toBe("merged");
    expect(job.reviews).toEqual({ security: "PASS", ux: "PASS", ui: "PASS", code: "PASS" });
  });

  it("accepts a worktree that git worktree add already created, and still runs the setup command", async () => {
    const repo = makeRepo();
    const { store } = memoryStore();
    await enqueueJob(options(repo, fake(repo).executor, { store }).options, fakeQueue(), { id: ID, feature: "Do X" });
    sh(repo, "worktree", "add", "-q", "-b", `factory/${ID}`, worktreeOf(repo), "main");
    let ranInWorktree = false;
    const { executor } = fake(repo, {
      hold: async (call) => {
        ranInWorktree ||= existsSync(join(call.cwd, "setup-ran"));
      },
    });
    const setup = ["node", "-e", "require('node:fs').writeFileSync('setup-ran', '')"];
    const { options: opts, notes } = options(repo, executor, { store, setup });
    const job = await resumeJob(opts, ID);
    expect(notes.some((n) => n.includes("worktree setup failed"))).toBe(false);
    expect(ranInWorktree).toBe(true);
    expect(job.stage).toBe("merged");
  });

  it("does nothing for a row awaiting nothing", async () => {
    const repo = makeRepo();
    const { store, row } = memoryStore();
    await enqueueJob(options(repo, fake(repo).executor, { store }).options, fakeQueue(), { id: ID, feature: "Do X" });
    const saved = row(repo)!;
    saved.state = { ...saved.state, job: { ...saved.state.job, stage: "needs-human" }, awaiting: "nothing" };
    const before = readFileSync(join(folder(repo), "job.json"), "utf8");
    const { executor, calls } = fake(repo);
    const job = await resumeJob(options(repo, executor, { store }).options, ID);
    expect(job).toEqual(saved.state.job);
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(folder(repo), "job.json"), "utf8")).toBe(before);
    expect(existsSync(worktreeOf(repo))).toBe(false);
  });

  it.each([
    ["branch", (s: SavedJob) => void (s.state.job.branch = "main")],
    ["worktree", (s: SavedJob) => void (s.state.job.worktree = "/tmp/elsewhere")],
    ["id", (s: SavedJob) => void (s.state.job.id = "004-y")],
    ["repo", (s: SavedJob) => void (s.state.repo = "/tmp/other")],
    ["awaiting", (s: SavedJob) => void Object.assign(s.state, { awaiting: "shipping" })],
    ["resumes", (s: SavedJob) => void (s.state.resumes = 3)],
    ["resumes", (s: SavedJob) => void (s.state.resumes = 0.5)],
    ["in-flight action", (s: SavedJob) => void (s.inFlight = [{ type: "writeFile", path: "/tmp/x", content: "x" }])],
    ["in-flight action", (s: SavedJob) => void (s.inFlight = [{ type: "notify", message: "x" }])],
    [
      "in-flight branch",
      (s: SavedJob) => void (s.inFlight = [{ type: "createWorktree", branch: "main", worktree: s.state.job.worktree }]),
    ],
    ["in-flight worktree", (s: SavedJob) => void (s.inFlight = [{ type: "removeWorktree", worktree: "/tmp/elsewhere" }])],
  ])("rejects a saved state with a bad %s before touching git or agents", async (field, tamper) => {
    const repo = makeRepo();
    const { store, row } = memoryStore();
    await enqueueJob(options(repo, fake(repo).executor, { store }).options, fakeQueue(), { id: ID, feature: "Do X" });
    tamper(row(repo)!);
    const before = readFileSync(join(folder(repo), "job.json"), "utf8");
    const { executor, calls } = fake(repo);
    await expect(resumeJob(options(repo, executor, { store }).options, ID)).rejects.toThrow(
      `${ID}: the saved state has ${field} `,
    );
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(folder(repo), "job.json"), "utf8")).toBe(before);
    expect(existsSync(worktreeOf(repo))).toBe(false);
    expect(sh(repo, "branch", "--list")).not.toContain("factory/");
  });

  it("throws when there is no saved row or no store", async () => {
    const repo = makeRepo();
    const { executor } = fake(repo);
    await expect(resumeJob(options(repo, executor, { store: memoryStore().store }).options, ID)).rejects.toThrow(
      `${ID}: no saved job for ${repo}`,
    );
    await expect(resumeJob(options(repo, executor).options, ID)).rejects.toThrow(/job store/);
  });
});

describe("a store on approveJob and reworkJob", () => {
  it("creates the row for a job run without one and saves the fresh builder's session", async () => {
    const repo = makeRepo();
    const first = fake(repo, { build: () => "STATUS: BLOCKED\n" });
    await runJob(options(repo, first.executor).options, { id: ID, feature: "Do X" });
    const { store, row } = memoryStore();
    const second = fake(repo);
    const job = await reworkJob(options(repo, second.executor, { store }).options, ID, "note");
    expect(job.stage).toBe("merged");
    expect(row(repo)?.state).toMatchObject({ awaiting: "nothing", job: { stage: "merged" } });
    expect(row(repo)?.sessions[builderName(ID)]).toBe("session-1");
  });
});
