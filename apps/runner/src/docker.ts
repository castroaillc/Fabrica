// Docker mode: every agent call runs in one container per job, launched from the fabrica/job image (images/job/).
// The container sees the job's worktree, job folder and git common dir at their host paths. The common dir is
// read-only except for what a commit writes (objects, refs, logs and this job's worktree git dir), and the job's
// worktree links are read-only too. Nothing else of the host reaches it: no host env, no ~/.claude, no database
// credentials. Model credentials reach it only as exec env vars.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderConfig } from "@fabrica/core";
import { providerEnv } from "@fabrica/core";
import type { AgentExecutor } from "./executor.js";
import { git } from "./git.js";
import { jobFolder } from "./jobFolder.js";
import { sdkQueryOptions } from "./sdkOptions.js";

export type Env = Record<string, string | undefined>;

export const JOB_IMAGE = "fabrica/job";
// Where images/job/Dockerfile installs agent.mjs and the Agent SDK.
export const IMAGE_DIR = "/opt/fabrica";

export interface Mount {
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface ContainerSpec {
  name: string;
  image: string;
  mounts: readonly Mount[];
  // "<uid>:<gid>" of the host user, so files written in the mounts stay theirs.
  user: string;
}

export interface ExecRequest {
  container: string;
  command: readonly string[];
  cwd: string;
  // The container process gets exactly these variables on top of the image's own.
  env: Record<string, string>;
  stdin: string;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// The only thing that touches Docker. dockerLauncher is the real one; tests pass a fake.
export interface ContainerLauncher {
  // Creates the container when it doesn't exist and starts it when it isn't running.
  ensure(spec: ContainerSpec): Promise<void>;
  exec(request: ExecRequest): Promise<ExecResult>;
  remove(name: string): Promise<void>;
}

// Variables the docker CLI itself needs to reach the daemon. Nothing else of the runner's env reaches it.
const CLI_ENV_KEYS: readonly string[] = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];

// Credential variables passed into the container per provider type, when set and non-empty in the runner's env.
const CREDENTIAL_KEYS: Record<Exclude<ProviderConfig["type"], "vertex">, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  "anthropic-compatible": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  bedrock: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"],
};

// A field of a --mount value, CSV-quoted as docker parses it, so commas or quotes in a path stay inside the field.
function mountField(field: string): string {
  return `"${field.replaceAll('"', '""')}"`;
}

// docker create: an idle process, the host user, the given bind mounts and nothing else. No env flags.
export function createArgs(spec: ContainerSpec): string[] {
  const mounts = spec.mounts.flatMap((mount) => [
    "--mount",
    ["type=bind", `source=${mount.source}`, `target=${mount.target}`, ...(mount.readOnly ? ["readonly"] : [])]
      .map(mountField)
      .join(","),
  ]);
  return ["create", "--name", spec.name, "--user", spec.user, ...mounts, spec.image, "sleep", "infinity"];
}

// docker exec: names only for -e, so values never appear on the argv. The CLI reads them from its own env.
export function execArgs(request: ExecRequest): string[] {
  const env = Object.keys(request.env).flatMap((name) => ["-e", name]);
  return ["exec", "-i", "-w", request.cwd, ...env, request.container, ...request.command];
}

// The docker CLI process env: the variables it needs to reach the daemon, plus the exec env's values.
export function cliEnv(hostEnv: Env, env: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of CLI_ENV_KEYS) {
    const value = hostEnv[key];
    if (value !== undefined) result[key] = value;
  }
  return { ...result, ...env };
}

function docker(args: readonly string[], env: Record<string, string>, stdin?: string): Promise<ExecResult> {
  return new Promise((done) => {
    const child = execFile("docker", args, { env, encoding: "utf8" }, (error, stdout, stderr) => {
      done({ ok: error === null, stdout, stderr: error && stderr.trim() === "" ? error.message : stderr });
    });
    child.stdin?.end(stdin ?? "");
  });
}

// The real launcher: the docker CLI through execFile, no shell. hostEnv is the runner's env (process.env).
export function dockerLauncher(hostEnv: Env): ContainerLauncher {
  const base = cliEnv(hostEnv);
  const state = async (name: string): Promise<"missing" | "running" | "stopped"> => {
    const inspect = await docker(["container", "inspect", "--format", "{{.State.Running}}", name], base);
    if (!inspect.ok) return "missing";
    return inspect.stdout.trim() === "true" ? "running" : "stopped";
  };
  return {
    async ensure(spec) {
      let current = await state(spec.name);
      if (current === "missing") {
        const create = await docker(createArgs(spec), base);
        // A concurrent call for the same job may have created it first.
        current = await state(spec.name);
        if (current === "missing") throw new Error(`docker create ${spec.name} failed: ${create.stderr.trim()}`);
      }
      if (current === "stopped") {
        const start = await docker(["start", spec.name], base);
        if (!start.ok && (await state(spec.name)) !== "running") {
          throw new Error(`docker start ${spec.name} failed: ${start.stderr.trim()}`);
        }
      }
    },
    exec(request) {
      return docker(execArgs(request), cliEnv(hostEnv, request.env), request.stdin);
    },
    async remove(name) {
      if ((await state(name)) === "missing") return;
      const remove = await docker(["rm", "--force", name], base);
      if (!remove.ok) throw new Error(`docker rm ${name} failed: ${remove.stderr.trim()}`);
    },
  };
}

// One container per job: the job folder's path tells repos apart that share a job id.
export function containerName(folder: string, id: string): string {
  const hash = createHash("sha256").update(folder).digest("hex").slice(0, 12);
  return `fabrica-${hash}-${id}`;
}

// The provider's routing variables plus its credentials from the runner's env. Vertex needs an ADC file, so it fails.
export function providerExecEnv(provider: ProviderConfig | undefined, hostEnv: Env): Record<string, string> {
  if (provider?.type === "vertex") throw new Error("Docker mode does not support the Vertex provider yet");
  const env: Record<string, string> = provider === undefined ? {} : providerEnv(provider);
  for (const key of CREDENTIAL_KEYS[provider?.type ?? "anthropic"]) {
    const value = hostEnv[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}

// GIT_AUTHOR_* and GIT_COMMITTER_* from the repo's git config on the host, so the builder can commit without
// ~/.gitconfig. Unset values are left out.
async function gitIdentity(cwd: string): Promise<Record<string, string>> {
  const identity: Record<string, string> = {};
  for (const [field, suffix] of [
    ["user.name", "NAME"],
    ["user.email", "EMAIL"],
  ] as const) {
    const value = await git(["config", field], cwd);
    if (!value.ok || value.stdout.trim() === "") continue;
    identity[`GIT_AUTHOR_${suffix}`] = value.stdout.trim();
    identity[`GIT_COMMITTER_${suffix}`] = value.stdout.trim();
  }
  return identity;
}

export interface DockerConfig {
  launcher: ContainerLauncher;
  // Defaults to fabrica/job.
  image?: string;
  // The runner's env: process.env in production.
  env: Env;
}

export interface DockerMode {
  executor: AgentExecutor;
  // Removes the job's container. Called once the job's worktree is removed.
  teardown: (repo: string, id: string) => Promise<void>;
}

export function dockerExecutor(config: DockerConfig): DockerMode {
  const { launcher, env: hostEnv } = config;
  const image = config.image ?? JOB_IMAGE;
  const executor: AgentExecutor = async (call) => {
    const name = call.agent.name;
    const credentials = providerExecEnv(call.provider, hostEnv);
    const dirs = await git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], call.cwd);
    const [gitDir, common] = dirs.stdout.trim().split("\n");
    if (!dirs.ok || gitDir === undefined || common === undefined) {
      throw new Error(`${name}: cannot find the git dirs of ${call.cwd}: ${dirs.error}`);
    }
    const container = containerName(call.jobFolder, call.jobId);
    const mounts = await gitMounts(call.cwd, call.jobFolder, gitDir, common);
    await launcher.ensure({ name: container, image, mounts, user: hostUser() });
    const options = sdkQueryOptions(call, {});
    delete options.env;
    const result = await launcher.exec({
      container,
      command: ["node", `${IMAGE_DIR}/agent.mjs`],
      cwd: call.cwd,
      env: { ...credentials, ...(await gitIdentity(call.cwd)) },
      stdin: JSON.stringify({ prompt: call.prompt, options }),
    });
    const reported = lastLine(result.stdout);
    if (reported?.error !== undefined) throw new Error(`${name} ended with an error: ${reported.error}`);
    if (reported?.sessionId !== undefined && result.ok) return { sessionId: reported.sessionId };
    throw new Error(`${name} returned no result from container ${container}: ${result.stderr.trim() || "no output"}`);
  };
  const teardown = (repo: string, id: string) => launcher.remove(containerName(jobFolder(repo, id), id));
  return { executor, teardown };
}

// The host runs git in the repo after agents finish, so an agent must not be able to plant config (fsmonitor,
// filters, hooksPath), hooks, attributes or a commondir file, or repoint any worktree's git dirs. The common dir is
// read-only, with read-write mounts only for what a commit writes; this job's worktree links stay read-only.
async function gitMounts(worktree: string, folder: string, gitDir: string, common: string): Promise<Mount[]> {
  if (gitDir === common) throw new Error(`${worktree} is not a linked worktree`);
  const writable = ["objects", "refs", "logs"].map((dir) => join(common, dir));
  // A missing directory can't be mounted, and git needs logs/ to record the commit's reflog.
  for (const dir of writable) await mkdir(dir, { recursive: true });
  // With extensions.worktreeConfig the host's git reads config.worktree in worktree remove's status check, so it
  // exists (empty when it didn't) to be mounted read-only.
  await writeFile(join(gitDir, "config.worktree"), "", { flag: "a" });
  const readOnly = [join(worktree, ".git"), ...["commondir", "gitdir", "config.worktree"].map((file) => join(gitDir, file))];
  return [
    ...[worktree, folder].map((path) => ({ source: path, target: path })),
    { source: common, target: common, readOnly: true },
    ...[...writable, gitDir].map((path) => ({ source: path, target: path })),
    ...readOnly.filter((path) => existsSync(path)).map((path) => ({ source: path, target: path, readOnly: true })),
  ];
}

function hostUser(): string {
  if (process.getuid === undefined || process.getgid === undefined) {
    throw new Error("Docker mode needs a host uid and gid to run containers as");
  }
  return `${process.getuid()}:${process.getgid()}`;
}

// agent.mjs's last stdout line: {"sessionId":"..."} or {"error":"..."}.
function lastLine(stdout: string): { sessionId?: string; error?: string } | undefined {
  const line = stdout.trimEnd().split("\n").pop() ?? "";
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { sessionId, error } = parsed as Record<string, unknown>;
    if (typeof error === "string") return { error };
    if (typeof sessionId === "string" && sessionId !== "") return { sessionId };
    return undefined;
  } catch {
    return undefined;
  }
}
