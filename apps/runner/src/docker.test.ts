import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentFile } from "@fabrica/core";
import type { ProviderConfig } from "@fabrica/core";
import { cliEnv, createArgs, dockerExecutor, execArgs } from "./docker.js";
import type { ContainerLauncher, ContainerSpec, ExecRequest, ExecResult } from "./docker.js";
import type { AgentCall } from "./executor.js";
import { sdkQueryOptions } from "./sdkOptions.js";

const ID = "003-x";
const BUILDER = parseAgentFile(
  "---\nname: builder\ndescription: Builds.\ntools: Read, Bash, Edit, Write\nmodel: opus\n---\n\nYou build.\n",
);

// The runner's env: credentials for every provider plus host variables that must never reach a container.
const HOST_ENV = {
  DATABASE_URL: "postgres://fabrica:db-secret@127.0.0.1:5432/fabrica",
  HOME: "/Users/someone",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  UNRELATED_SECRET: "unrelated-secret",
  DOCKER_HOST: "unix:///var/run/docker.sock",
  ANTHROPIC_API_KEY: "sk-ant-key",
  ANTHROPIC_AUTH_TOKEN: "auth-token",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
  AWS_ACCESS_KEY_ID: "aws-id",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  AWS_SESSION_TOKEN: "",
  AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer",
  CLAUDE_CODE_USE_VERTEX: "1",
};
const SECRETS = [
  "db-secret",
  "unrelated-secret",
  "sk-ant-key",
  "auth-token",
  "oauth-token",
  "aws-id",
  "aws-secret",
  "bedrock-bearer",
];
const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A temp repo on main with a worktree and a job folder per id, laid out as the runner creates them.
function makeRepo(ids: string[] = [ID]): { repo: string; worktree: (id: string) => string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-docker-")));
  temps.push(root);
  const repo = join(root, "app");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "README.md"), "hello\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "Initial");
  const worktree = (id: string) => join(root, "app-factory", id);
  for (const id of ids) {
    sh(repo, "worktree", "add", "-q", "-b", `factory/${id}`, worktree(id), "main");
    mkdirSync(join(repo, "factory", "jobs", id), { recursive: true });
  }
  return { repo, worktree };
}

function callFor(repo: string, worktree: string, id = ID, extra: Partial<AgentCall> = {}): AgentCall {
  const jobFolder = join(repo, "factory", "jobs", id);
  return { agent: BUILDER, prompt: "Build it.", cwd: worktree, jobId: id, jobFolder, ...extra };
}

interface Fake {
  launcher: ContainerLauncher;
  ensured: ContainerSpec[];
  execs: ExecRequest[];
  removed: string[];
}

function fakeLauncher(result: ExecResult = { ok: true, stdout: '{"sessionId":"s-1"}\n', stderr: "" }): Fake {
  const fake: Fake = {
    ensured: [],
    execs: [],
    removed: [],
    launcher: {
      async ensure(spec) {
        fake.ensured.push(spec);
      },
      async exec(request) {
        fake.execs.push(request);
        return result;
      },
      async remove(name) {
        fake.removed.push(name);
      },
    },
  };
  return fake;
}

describe("dockerExecutor", () => {
  it("uses one container per job, named from the repo and the job id", async () => {
    const one = makeRepo([ID, "004-y"]);
    const other = makeRepo();
    const fake = fakeLauncher();
    const { executor } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    await executor(callFor(one.repo, one.worktree(ID)));
    await executor(callFor(one.repo, one.worktree(ID), ID, { agent: { ...BUILDER, name: "reviewer-ux" } }));
    await executor(callFor(one.repo, one.worktree("004-y"), "004-y"));
    await executor(callFor(other.repo, other.worktree(ID)));
    const names = fake.ensured.map((spec) => spec.name);
    expect(names[0]).toBe(names[1]);
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^fabrica-[0-9a-f]{12}-\d{3}-[a-z]$/);
    expect(fake.execs.map((exec) => exec.container)).toEqual(names);
  });

  it("mounts the worktree, the job folder and the git common dir at their host paths, the common dir read-only", async () => {
    const { repo, worktree } = makeRepo();
    const fake = fakeLauncher();
    const { executor } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    await executor(callFor(repo, worktree(ID)));
    const [spec] = fake.ensured;
    const same = (path: string) => ({ source: path, target: path });
    const readOnly = (path: string) => ({ source: path, target: path, readOnly: true });
    const common = join(repo, ".git");
    expect(spec?.mounts).toEqual([
      same(worktree(ID)),
      same(join(repo, "factory", "jobs", ID)),
      // Read-only, so an agent can't plant git config, hooks or a commondir file the host later reads.
      readOnly(common),
      // Only what a commit writes is writable.
      same(join(common, "objects")),
      same(join(common, "refs")),
      same(join(common, "logs")),
      same(join(common, "worktrees", ID)),
      // This job's worktree links stay read-only inside its writable git dir.
      readOnly(join(worktree(ID), ".git")),
      readOnly(join(common, "worktrees", ID, "commondir")),
      readOnly(join(common, "worktrees", ID, "gitdir")),
      readOnly(join(common, "worktrees", ID, "config.worktree")),
    ]);
    expect(spec?.image).toBe("fabrica/job");
    expect(spec?.user).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
  });

  it("execs agent.mjs in the worktree", async () => {
    const { repo, worktree } = makeRepo();
    const fake = fakeLauncher();
    const { executor } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV, image: "fabrica/job:test" });
    await executor(callFor(repo, worktree(ID)));
    expect(fake.ensured[0]?.image).toBe("fabrica/job:test");
    expect(fake.execs[0]?.command).toEqual(["node", "/opt/fabrica/agent.mjs"]);
    expect(fake.execs[0]?.cwd).toBe(worktree(ID));
  });

  it("passes exactly the provider's variables, its credentials and the git identity", async () => {
    const { repo, worktree } = makeRepo();
    const fake = fakeLauncher();
    const { executor } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    const cases: [ProviderConfig | undefined, Record<string, string>][] = [
      [
        undefined,
        {
          ANTHROPIC_API_KEY: "sk-ant-key",
          ANTHROPIC_AUTH_TOKEN: "auth-token",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
          ...IDENTITY,
        },
      ],
      [
        { type: "anthropic" },
        {
          ANTHROPIC_API_KEY: "sk-ant-key",
          ANTHROPIC_AUTH_TOKEN: "auth-token",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
          ...IDENTITY,
        },
      ],
      [
        { type: "bedrock", region: "us-east-1" },
        {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "aws-id",
          AWS_SECRET_ACCESS_KEY: "aws-secret",
          AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer",
          ...IDENTITY,
        },
      ],
      [
        { type: "anthropic-compatible", base_url: "https://litellm:4000" },
        {
          ANTHROPIC_BASE_URL: "https://litellm:4000",
          ANTHROPIC_API_KEY: "sk-ant-key",
          ANTHROPIC_AUTH_TOKEN: "auth-token",
          ...IDENTITY,
        },
      ],
    ];
    for (const [provider, env] of cases) {
      await executor(callFor(repo, worktree(ID), ID, provider === undefined ? {} : { provider }));
      expect(fake.execs.at(-1)?.env, provider?.type ?? "no provider").toEqual(env);
    }
  });

  it("leaves out git identity variables that are unset", async () => {
    const { repo, worktree } = makeRepo();
    sh(repo, "config", "--unset", "user.email");
    const fake = fakeLauncher();
    const { executor } = dockerExecutor({ launcher: fake.launcher, env: { ANTHROPIC_API_KEY: "k" } });
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      await executor(callFor(repo, worktree(ID)));
    } finally {
      for (const [key, value] of [
        ["GIT_CONFIG_GLOBAL", saved.global],
        ["GIT_CONFIG_NOSYSTEM", saved.nosystem],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(fake.execs[0]?.env).toEqual({ ANTHROPIC_API_KEY: "k", GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test" });
  });

  it("never puts env values on the docker argv, and gives the docker CLI only what it needs", async () => {
    const { repo, worktree } = makeRepo();
    const fake = fakeLauncher();
    const { executor } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    await executor(callFor(repo, worktree(ID), ID, { provider: { type: "bedrock", region: "us-east-1" } }));
    const [spec] = fake.ensured;
    const [request] = fake.execs;
    if (spec === undefined || request === undefined) throw new Error("no container call");
    const create = createArgs(spec);
    const exec = execArgs(request);
    for (const secret of SECRETS) {
      expect(create.join(" ")).not.toContain(secret);
      expect(exec.join(" ")).not.toContain(secret);
    }
    expect(create).not.toContain("--privileged");
    expect(create.some((arg) => arg.startsWith("--env") || arg === "-e")).toBe(false);
    expect(create.join(" ")).not.toContain("docker.sock");
    expect(create.slice(create.indexOf("--user"), create.indexOf("--user") + 2)).toEqual(["--user", spec.user]);
    const mounts = create.flatMap((arg, i) => (create[i - 1] === "--mount" ? [arg] : []));
    expect(mounts).toHaveLength(spec.mounts.length);
    expect(mounts.filter((mount) => !mount.endsWith(',"readonly"'))).toHaveLength(6);
    expect(create.filter((arg) => arg === "-v" || arg === "--volume")).toEqual([]);
    expect(create.slice(-3)).toEqual(["fabrica/job", "sleep", "infinity"]);
    const names = exec.flatMap((arg, i) => (exec[i - 1] === "-e" ? [arg] : []));
    expect(names.sort()).toEqual(Object.keys(request.env).sort());
    for (const name of names) expect(name).toMatch(/^[A-Z_]+$/);
    expect(exec.some((arg) => arg.startsWith("--env"))).toBe(false);
    expect(cliEnv(HOST_ENV, request.env)).toEqual({
      PATH: HOST_ENV.PATH,
      HOME: HOST_ENV.HOME,
      DOCKER_HOST: HOST_ENV.DOCKER_HOST,
      ...request.env,
    });
  });

  it("quotes mount fields so a comma in a path stays in its field", () => {
    const args = createArgs({ name: "c", image: "i", user: "1:2", mounts: [{ source: "/a,b", target: "/a,b" }] });
    expect(args[args.indexOf("--mount") + 1]).toBe('"type=bind","source=/a,b","target=/a,b"');
  });

  it("marks read-only mounts readonly", () => {
    const mounts = [{ source: "/a", target: "/a", readOnly: true }];
    const args = createArgs({ name: "c", image: "i", user: "1:2", mounts });
    expect(args[args.indexOf("--mount") + 1]).toBe('"type=bind","source=/a","target=/a","readonly"');
  });

  it("sends the prompt and the SDK options without env on stdin, including resume", async () => {
    const { repo, worktree } = makeRepo();
    const fake = fakeLauncher();
    const { executor } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    const provider = { type: "bedrock", region: "us-east-1" } as const;
    const call = callFor(repo, worktree(ID), ID, { provider, resume: "s-0", prompt: "Round 2." });
    await executor(call);
    const sent = JSON.parse(fake.execs[0]?.stdin ?? "") as { prompt: string; options: Record<string, unknown> };
    const { env: _env, ...expected } = sdkQueryOptions(call, {});
    expect(sent).toEqual({ prompt: "Round 2.", options: expected });
    expect(sent.options.resume).toBe("s-0");
    expect("env" in sent.options).toBe(false);
  });

  it("returns the session id from the last stdout line", async () => {
    const { repo, worktree } = makeRepo();
    const stdout = 'some output\n{"sessionId":"s-9"}\n';
    const fake = fakeLauncher({ ok: true, stdout, stderr: "" });
    const { executor } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    expect(await executor(callFor(repo, worktree(ID)))).toEqual({ sessionId: "s-9" });
  });

  it("throws the reported error with the agent's name", async () => {
    const { repo, worktree } = makeRepo();
    const fake = fakeLauncher({ ok: false, stdout: '\n{"error":"max turns"}\n', stderr: "" });
    const { executor } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    await expect(executor(callFor(repo, worktree(ID)))).rejects.toThrow("builder ended with an error: max turns");
  });

  it("throws when the exec ends without a JSON result line", async () => {
    const { repo, worktree } = makeRepo();
    const { executor } = dockerExecutor({
      launcher: fakeLauncher({ ok: false, stdout: "", stderr: "OCI runtime exec failed" }).launcher,
      env: HOST_ENV,
    });
    await expect(executor(callFor(repo, worktree(ID)))).rejects.toThrow(/builder.*OCI runtime exec failed/);
    const garbled = fakeLauncher({ ok: true, stdout: "{oops", stderr: "" });
    const { executor: second } = dockerExecutor({ launcher: garbled.launcher, env: {} });
    await expect(second(callFor(repo, worktree(ID)))).rejects.toThrow(/builder returned no result/);
  });

  it("rejects a Vertex role without starting or running anything", async () => {
    const { repo, worktree } = makeRepo();
    const fake = fakeLauncher();
    const { executor } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    const provider = { type: "vertex", project: "acme", region: "us-east5" } as const;
    await expect(executor(callFor(repo, worktree(ID), ID, { provider }))).rejects.toThrow(
      "Docker mode does not support the Vertex provider",
    );
    expect(fake.ensured).toEqual([]);
    expect(fake.execs).toEqual([]);
  });

  it("refuses a cwd that is not a linked worktree, whose git dir is the common dir", async () => {
    const { repo } = makeRepo();
    const fake = fakeLauncher();
    const { executor } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    await expect(executor(callFor(repo, repo))).rejects.toThrow(`${repo} is not a linked worktree`);
    expect(fake.ensured).toEqual([]);
  });

  it("tears down by removing the job's container", async () => {
    const { repo, worktree } = makeRepo();
    const fake = fakeLauncher();
    const { executor, teardown } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    await executor(callFor(repo, worktree(ID)));
    await teardown(repo, ID);
    expect(fake.removed).toEqual([fake.ensured[0]?.name]);
  });
});

describe("dockerExecutor setup", () => {
  const SETUP = ["pnpm", "install", "--frozen-lockfile", "a b; echo $HOME"];

  function setupFor(repo: string, worktree: string, id = ID) {
    return { command: SETUP, cwd: worktree, jobId: id, jobFolder: join(repo, "factory", "jobs", id) };
  }

  it("ensures the same container an agent call for the job ensures, and the agent call reuses it", async () => {
    const { repo, worktree } = makeRepo();
    const fake = fakeLauncher();
    const { executor, setup } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    await setup(setupFor(repo, worktree(ID)));
    await executor(callFor(repo, worktree(ID)));
    const [forSetup, forAgent] = fake.ensured;
    expect(forSetup).toBeDefined();
    expect(forSetup).toEqual(forAgent);
    expect(fake.execs.map((exec) => exec.container)).toEqual([forSetup?.name, forSetup?.name]);
  });

  it("execs the argv verbatim in the worktree with an empty env and no stdin, credentials and identity aside", async () => {
    const { repo, worktree } = makeRepo();
    const fake = fakeLauncher({ ok: true, stdout: "installed\n", stderr: "" });
    const { setup } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    expect(await setup(setupFor(repo, worktree(ID)))).toEqual({ ok: true, output: "installed" });
    const [request] = fake.execs;
    if (request === undefined) throw new Error("no exec");
    expect(request.command).toEqual(SETUP);
    expect(request.cwd).toBe(worktree(ID));
    expect(request.env).toEqual({});
    expect(request.stdin).toBe("");
    const exec = execArgs(request);
    expect(exec).not.toContain("-e");
    for (const value of [...SECRETS, ...Object.values(IDENTITY)]) expect(exec.join(" ")).not.toContain(value);
    expect(exec.slice(-SETUP.length)).toEqual(SETUP);
  });

  it("returns ok false with both stdout and stderr when the exec fails", async () => {
    const { repo, worktree } = makeRepo();
    const fake = fakeLauncher({ ok: false, stdout: "  resolving\n", stderr: "ERR_PNPM_LOCKFILE\n" });
    const { setup } = dockerExecutor({ launcher: fake.launcher, env: HOST_ENV });
    expect(await setup(setupFor(repo, worktree(ID)))).toEqual({ ok: false, output: "resolving\nERR_PNPM_LOCKFILE" });
  });
});
