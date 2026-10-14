// Runs against a real Docker daemon only when the fabrica/job image is built; skipped otherwise, never failed.
// Execs shell commands in a job container (no model) and removes the container afterwards.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentFile } from "@fabrica/core";
import { dockerExecutor, dockerLauncher } from "./docker.js";
import type { ContainerLauncher, ContainerSpec } from "./docker.js";

function imageBuilt(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", "fabrica/job"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ID = "003-x";
const OTHER = "004-y";
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe.skipIf(!imageBuilt())("a job container from fabrica/job", () => {
  it("sees only the worktree, job folder and git common dir, mostly read-only, and no host env", { timeout: 120_000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-docker-it-")));
    temps.push(root);
    const repo = join(root, "app");
    mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.name", "Test");
    sh(repo, "config", "user.email", "test@example.com");
    writeFileSync(join(repo, "README.md"), "hello\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-q", "-m", "Initial");
    const worktree = join(root, "app-factory", ID);
    sh(repo, "worktree", "add", "-q", "-b", `factory/${ID}`, worktree, "main");
    sh(repo, "worktree", "add", "-q", "-b", `factory/${OTHER}`, join(root, "app-factory", OTHER), "main");
    const folder = join(repo, "factory", "jobs", ID);
    mkdirSync(folder, { recursive: true });

    // The real launcher, with exec stubbed for the executor's one agent call so no model runs.
    const real = dockerLauncher(process.env);
    let spec: ContainerSpec | undefined;
    const launcher: ContainerLauncher = {
      ensure: async (given) => {
        spec = given;
        await real.ensure(given);
      },
      exec: async () => ({ ok: true, stdout: '{"sessionId":"s-1"}\n', stderr: "" }),
      remove: (name) => real.remove(name),
    };
    const { executor, teardown } = dockerExecutor({ launcher, env: process.env });
    const agent = parseAgentFile("---\nname: builder\ndescription: Builds.\n---\n\nYou build.\n");
    try {
      await executor({ agent, prompt: "Go.", cwd: worktree, jobId: ID, jobFolder: folder });
      if (spec === undefined) throw new Error("no container was ensured");
      const container = spec.name;
      const env = {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "t@e.st",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "t@e.st",
        FABRICA_PASSED: "passed",
      };
      const exec = (command: string[], cwd = worktree, stdin = "") =>
        real.exec({ container, command, cwd, env, stdin });
      const shell = async (script: string) => {
        const result = await exec(["sh", "-c", script]);
        expect(result.ok, `${script}\n${result.stderr}`).toBe(true);
        return result.stdout;
      };

      await shell(`echo built > ${worktree}/built.txt && echo review > ${folder}/review.md`);
      expect(existsSync(join(worktree, "built.txt"))).toBe(true);
      expect(existsSync(join(folder, "review.md"))).toBe(true);

      await shell(`git -C ${worktree} status && git -C ${worktree} add built.txt`);
      await shell(`git -C ${worktree} commit -q -m Built`);
      expect(sh(repo, "log", "-1", "--format=%s %an", `factory/${ID}`).trim()).toBe("Built Test");

      await shell(`test ! -e ${repo}/README.md`);

      // The common dir is read-only apart from what the commit above wrote, and so are this job's worktree links:
      // nothing the host's git reads later can be planted, including a commondir that redirects the main checkout.
      const git = join(repo, ".git");
      const gitDir = join(git, "worktrees", ID);
      const other = join(git, "worktrees", OTHER);
      for (const target of [
        join(git, "config"),
        join(git, "config.worktree"),
        join(git, "commondir"),
        join(git, "hooks", "post-merge"),
        join(git, "info", "attributes"),
        join(worktree, ".git"),
        join(gitDir, "commondir"),
        join(gitDir, "gitdir"),
        join(gitDir, "config.worktree"),
        join(other, "commondir"),
        join(other, "gitdir"),
      ]) {
        const write = await exec(["sh", "-c", `echo planted >> ${target}`]);
        expect(write.ok, `${target} is writable`).toBe(false);
      }
      expect(readFileSync(join(git, "config"), "utf8")).not.toContain("planted");
      expect(existsSync(join(git, "commondir"))).toBe(false);
      expect(readFileSync(join(other, "commondir"), "utf8")).not.toContain("planted");
      await shell(`test ! -e ${homedir()}/.claude && test ! -e "$HOME/.claude"`);

      const printed = await exec(["node", "-e", "console.log(JSON.stringify(process.env))"]);
      const seen = JSON.parse(printed.stdout) as Record<string, string>;
      expect(seen.FABRICA_PASSED).toBe("passed");
      expect(seen.HOME).toBe("/home/fabrica");
      for (const [key, value] of Object.entries(process.env)) {
        if (key in env) continue;
        expect(seen[key] === value && value !== "", `host ${key} reached the container`).toBe(false);
      }

      const load = "const m = await import('@anthropic-ai/claude-agent-sdk'); console.log(typeof m.query)";
      const sdk = await exec(["node", "--input-type=module", "-e", load], "/opt/fabrica");
      expect(sdk.stdout.trim()).toBe("function");

      const bad = await exec(["node", "/opt/fabrica/agent.mjs"], worktree, "not json");
      expect(bad.ok).toBe(false);
      expect(JSON.parse(bad.stdout.trimEnd().split("\n").pop() ?? "")).toHaveProperty("error");
    } finally {
      await teardown(repo, ID);
    }
    const left = execFileSync("docker", ["ps", "-a", "--filter", `name=${spec?.name}`, "--format", "{{.Names}}"], {
      encoding: "utf8",
    });
    expect(left.trim()).toBe("");
  });
});
