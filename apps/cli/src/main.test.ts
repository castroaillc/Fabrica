import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEWERS } from "@fabrica/core";
import type { JobState } from "@fabrica/core";
import { runJob } from "@fabrica/runner";
import type { AgentCall, AgentExecutor } from "@fabrica/runner";
import { main, slug } from "./main.js";

// runJob stays the real one; the EEXIST test wraps a single call to create the folder just before it runs.
vi.mock("@fabrica/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fabrica/runner")>();
  return { ...actual, runJob: vi.fn(actual.runJob) };
});

const AGENTS = ["spec-writer", "builder", ...REVIEWERS.map((r) => `reviewer-${r}`), "approver"];

const temps: string[] = [];
let commits = 0;
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function agentFile(name: string): string {
  const tools = name === "builder" ? "Read, Grep, Glob, Bash, Edit, Write" : "Read, Grep, Glob, Bash, Write";
  const model = name.startsWith("reviewer-") ? "sonnet" : "opus";
  return `---\nname: ${name}\ndescription: Fixture ${name}.\ntools: ${tools}\nmodel: ${model}\n---\n\nYou are the ${name} fixture.\n`;
}

// A temp repo on main with fixture agents, a gitignored factory/jobs/ and a tracked backlog.
function makeRepo(backlog = "# Backlog\n"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-cli-")));
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
  writeFileSync(join(repo, "README.md"), "hello\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "Initial");
  return repo;
}

function jobsDir(repo: string): string {
  return join(repo, "factory", "jobs");
}

function readJob(repo: string, id: string): JobState {
  return JSON.parse(readFileSync(join(jobsDir(repo), id, "job.json"), "utf8")) as JobState;
}

interface Script {
  build?: () => string;
  decision?: () => string;
}

// A fake executor that writes each agent's fixed file into the job folder named by the worktree, and records every call.
function fake(repo: string, script: Script = {}): { executor: AgentExecutor; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  const executor: AgentExecutor = async (call) => {
    calls.push(call);
    const folder = join(jobsDir(repo), basename(call.cwd));
    const name = call.agent.name;
    if (name === "spec-writer") writeFileSync(join(folder, "spec.md"), "# Spec\n");
    if (name === "builder") {
      commits += 1;
      writeFileSync(join(call.cwd, `file-${commits}.txt`), "build\n");
      sh(call.cwd, "add", `file-${commits}.txt`);
      sh(call.cwd, "commit", "-q", "-m", `Build ${commits}`);
      writeFileSync(join(folder, "build.md"), script.build?.() ?? "STATUS: READY\n\n# Build\n");
    }
    if (name.startsWith("reviewer-")) {
      const round = Number(call.prompt.match(/Review round (\d+)\./)?.[1]);
      writeFileSync(join(folder, `round-${round}`, `review-${name.slice("reviewer-".length)}.md`), "VERDICT: PASS\n");
    }
    if (name === "approver") writeFileSync(join(folder, "decision.md"), script.decision?.() ?? "APPROVE\n");
    return { sessionId: `session-${calls.length}` };
  };
  return { executor, calls };
}

async function cli(argv: string[], cwd: string, executor: AgentExecutor = fake(cwd).executor) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { cwd, executor, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

describe("slug", () => {
  it("takes the first 4 lowercase alphanumeric words", () => {
    expect(slug("Add a 404 page")).toBe("add-a-404-page");
    expect(slug("  CLI in apps/cli: `fabrica run`, next")).toBe("cli-in-apps-cli");
    expect(slug("Ünïcode—only?")).toBe("n-code-only");
    expect(slug("!!! ???")).toBe("job");
  });
});

describe("run", () => {
  it("creates 001-<slug>, runs it to a merge and prints the final line", async () => {
    const repo = makeRepo();
    const { code, out, err } = await cli(["run", "Add", "a", "404", "page"], repo);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(existsSync(join(jobsDir(repo), "001-add-a-404-page"))).toBe(true);
    expect(readJob(repo, "001-add-a-404-page").feature).toBe("Add a 404 page");
    expect(out.at(-1)).toBe("001-add-a-404-page: merged");
    // notify messages come before the final line, each already prefixed with the job id.
    expect(out.length).toBeGreaterThan(1);
    expect(out.slice(0, -1).every((m) => m.startsWith("001-add-a-404-page: "))).toBe(true);
  });

  it("takes the number after the highest job folder", async () => {
    const repo = makeRepo();
    mkdirSync(join(jobsDir(repo), "001-x"), { recursive: true });
    const { code, out } = await cli(["run", "Add a 404 page"], repo);
    expect(code).toBe(0);
    expect(out.at(-1)).toBe("002-add-a-404-page: merged");
  });

  it("works from a subdirectory of the repo", async () => {
    const repo = makeRepo();
    const { code, out } = await cli(["run", "Sub dir"], join(repo, "factory"), fake(repo).executor);
    expect(code).toBe(0);
    expect(out.at(-1)).toBe("001-sub-dir: merged");
  });

  it("picks the next number when the folder appears between the read and runJob's mkdir", async () => {
    const repo = makeRepo();
    const actual = await vi.importActual<typeof import("@fabrica/runner")>("@fabrica/runner");
    vi.mocked(runJob).mockImplementationOnce(async (options, input) => {
      mkdirSync(join(jobsDir(repo), input.id), { recursive: true });
      return actual.runJob(options, input);
    });
    const { code, out, err } = await cli(["run", "Race"], repo);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(vi.mocked(runJob).mock.calls.map(([, input]) => input.id).slice(-2)).toEqual(["001-race", "002-race"]);
    expect(readdirSync(join(jobsDir(repo), "001-race"))).toEqual([]);
    expect(out.at(-1)).toBe("002-race: merged");
  });

  it("prints a runner exception to stderr and exits 1", async () => {
    const repo = makeRepo();
    rmSync(join(repo, ".claude", "agents"), { recursive: true });
    const { code, err } = await cli(["run", "X"], repo);
    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^fabrica: .*ENOENT/);
  });
});

describe("next", () => {
  it("claims the first unchecked line, runs it and leaves the line as checked with the job id", async () => {
    const backlog = "# Backlog\n\n- [x] Done thing → 001-done-thing\n- [ ] Add a 404 page\n- [ ] Second item\n";
    const repo = makeRepo(backlog);
    const { code, out } = await cli(["next"], repo);
    expect(code).toBe(0);
    expect(out.at(-1)).toBe("001-add-a-404-page: merged");
    expect(readJob(repo, "001-add-a-404-page").feature).toBe("Add a 404 page");
    expect(readFileSync(join(repo, "factory", "backlog.md"), "utf8")).toBe(
      backlog.replace("- [ ] Add a 404 page", "- [x] Add a 404 page → 001-add-a-404-page"),
    );
  });

  it("rewrites the line's id when an EEXIST retry picks the next number", async () => {
    const repo = makeRepo("- [ ] Race\n");
    const ids: string[] = [];
    const actual = await vi.importActual<typeof import("@fabrica/runner")>("@fabrica/runner");
    vi.mocked(runJob).mockImplementationOnce(async (options, input) => {
      ids.push(readFileSync(join(repo, "factory", "backlog.md"), "utf8"));
      mkdirSync(join(jobsDir(repo), input.id), { recursive: true });
      return actual.runJob(options, input);
    });
    const { code, out } = await cli(["next"], repo);
    expect(code).toBe(0);
    expect(ids).toEqual(["- [x] Race → 001-race\n"]);
    expect(out.at(-1)).toBe("002-race: merged");
    expect(readFileSync(join(repo, "factory", "backlog.md"), "utf8")).toBe("- [x] Race → 002-race\n");
  });

  it("says so and creates no job when there is no unchecked item", async () => {
    const backlog = "# Backlog\n\n- [x] Done thing → 001-done-thing\n";
    const repo = makeRepo(backlog);
    const { executor, calls } = fake(repo);
    const { code, out } = await cli(["next"], repo, executor);
    expect(code).toBe(0);
    expect(out).toEqual(["No unchecked items in factory/backlog.md."]);
    expect(existsSync(jobsDir(repo))).toBe(false);
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(repo, "factory", "backlog.md"), "utf8")).toBe(backlog);
  });

  it("exits 1 when the backlog is missing", async () => {
    const repo = makeRepo();
    rmSync(join(repo, "factory", "backlog.md"));
    const { code, err } = await cli(["next"], repo);
    expect(code).toBe(1);
    expect(err).toEqual([`fabrica: no backlog at ${join(repo, "factory", "backlog.md")}`]);
  });
});

describe("approve and rework", () => {
  it("approve merges a needs-human job", async () => {
    const repo = makeRepo();
    // The approver dirties the main checkout, so the merge is held back and the job goes to needs-human.
    const { executor } = fake(repo, {
      decision: () => {
        writeFileSync(join(repo, "stray.txt"), "untracked\n");
        return "APPROVE\n";
      },
    });
    const first = await cli(["run", "Do X"], repo, executor);
    expect(first.out.at(-1)).toBe("001-do-x: needs-human");
    rmSync(join(repo, "stray.txt"));

    const { code, out } = await cli(["approve", "001-do-x"], repo);
    expect(code).toBe(0);
    expect(out.at(-1)).toBe("001-do-x: merged");
    expect(sh(repo, "log", "-1", "--format=%s", "main").trim()).toBe("Merge factory/001-do-x");
  });

  it("approve leaves a job outside needs-human to core's check", async () => {
    const repo = makeRepo();
    await cli(["run", "Do X"], repo);
    const { code, out } = await cli(["approve", "001-do-x"], repo);
    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toMatch(/^001-do-x: /);
    expect(out.at(-1)).toBe("001-do-x: merged");
  });

  it("rework writes rework-1.md with the joined note and resumes the loop", async () => {
    const repo = makeRepo();
    const blocked = await cli(["run", "Do X"], repo, fake(repo, { build: () => "STATUS: BLOCKED\n" }).executor);
    expect(blocked.out.at(-1)).toBe("001-do-x: needs-human");

    const { executor, calls } = fake(repo);
    const { code, out } = await cli(["rework", "001-do-x", "some", "note", "words"], repo, executor);
    expect(code).toBe(0);
    expect(readFileSync(join(jobsDir(repo), "001-do-x", "rework-1.md"), "utf8")).toContain("some note words");
    expect(calls.some((c) => c.agent.name === "builder")).toBe(true);
    expect(out.at(-1)).toBe("001-do-x: merged");
  });

  it.each([
    [["approve", "../003-x"]],
    [["rework", "../003-x", "note"]],
  ])("rejects an invalid id before anything else: %j", async (argv) => {
    const repo = makeRepo();
    const { executor, calls } = fake(repo);
    const { code, out, err } = await cli(argv, repo, executor);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["fabrica: invalid job id: ../003-x"]);
    expect(existsSync(jobsDir(repo))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("checks the id before the repo", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-cli-nogit-")));
    temps.push(dir);
    const { code, err } = await cli(["approve", "nope"], dir);
    expect(code).toBe(1);
    expect(err).toEqual(["fabrica: invalid job id: nope"]);
  });
});

describe("status", () => {
  it("prints one line per valid job folder, sorted, and skips other names", async () => {
    const repo = makeRepo();
    await cli(["run", "Do X"], repo);
    mkdirSync(join(jobsDir(repo), "000-broken"));
    writeFileSync(join(jobsDir(repo), "000-broken", "job.json"), "{ not json");
    mkdirSync(join(jobsDir(repo), "002-empty"));
    mkdirSync(join(jobsDir(repo), "Not-A-Job"));
    writeFileSync(join(jobsDir(repo), "003-file"), "");
    const { code, out, err } = await cli(["status"], repo);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out).toEqual([
      "000-broken  (no readable job.json)",
      "001-do-x  merged  round 1  security PASS  ux PASS  ui PASS  code PASS",
      "002-empty  (no readable job.json)",
    ]);
  });

  it("prints pending reviews as they are in job.json", async () => {
    const repo = makeRepo();
    const job = {
      id: "007-x",
      feature: "X",
      branch: "factory/007-x",
      worktree: "/w",
      stage: "review",
      round: 2,
      reviews: { security: "PASS", ux: "pending", ui: "CHANGES", code: "pending" },
    };
    mkdirSync(join(jobsDir(repo), "007-x"), { recursive: true });
    writeFileSync(join(jobsDir(repo), "007-x", "job.json"), JSON.stringify(job));
    const { out } = await cli(["status"], repo);
    expect(out).toEqual(["007-x  review  round 2  security PASS  ux pending  ui CHANGES  code pending"]);
  });

  it("prints No jobs. when the folder is missing or has no job folders", async () => {
    const repo = makeRepo();
    expect(await cli(["status"], repo)).toEqual({ code: 0, out: ["No jobs."], err: [] });
    mkdirSync(join(jobsDir(repo), "scratch"), { recursive: true });
    expect(await cli(["status"], repo)).toEqual({ code: 0, out: ["No jobs."], err: [] });
  });

  it("exits 1 outside a git repository", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-cli-nogit-")));
    temps.push(dir);
    expect(await cli(["status"], dir)).toEqual({ code: 1, out: [], err: ["fabrica: not inside a git repository"] });
  });
});

describe("usage", () => {
  it.each([
    [[]],
    [["frobnicate"]],
    [["run"]],
    [["run", " "]],
    [["next", "extra"]],
    [["approve"]],
    [["approve", "001-x", "extra"]],
    [["rework", "001-x"]],
    [["rework"]],
    [["status", "foo"]],
  ])("prints usage to stderr and exits 1 for %j", async (argv) => {
    const repo = makeRepo();
    const { executor, calls } = fake(repo);
    const { code, out, err } = await cli(argv, repo, executor);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    const text = err.join("\n");
    for (const command of ["run", "next", "approve", "rework", "status"]) expect(text).toContain(`  ${command}`);
    expect(existsSync(jobsDir(repo))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each([["-h"], ["--help"]])("prints the same usage to stdout and exits 0 for %s", async (flag) => {
    const repo = makeRepo();
    const help = await cli([flag], repo);
    const bad = await cli([], repo);
    expect(help.code).toBe(0);
    expect(help.err).toEqual([]);
    expect(help.out).toEqual(bad.err);
  });
});
