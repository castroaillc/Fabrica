// Executes core's orchestrator actions on the host: git worktrees, agents through an AgentExecutor, job.json.
// Each entry point runs actions in order and feeds every outcome back through transition until awaiting "nothing".
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  STAGES,
  nextReworkNumber,
  parseAgentDirectory,
  parseFabricaConfig,
  startJob,
  stateFromJob,
  transition,
} from "@fabrica/core";
import type {
  Action,
  AgentDefinition,
  AgentName,
  JobState,
  OrchestratorEvent,
  OrchestratorState,
  ProviderConfig,
  Transition,
} from "@fabrica/core";
import type { AgentCall, AgentExecutor } from "./executor.js";
import { git, run } from "./git.js";
import { createJobDir, isValidJobId, jobFolder, writeJobFile } from "./jobFolder.js";

export interface RunnerOptions {
  repo: string;
  executor: AgentExecutor;
  notify: (message: string) => void;
  setup?: string[];
}

interface Context {
  repo: string;
  id: string;
  options: RunnerOptions;
  agents: Record<string, AgentDefinition>;
  // Provider and model by agent name, from fabrica.yaml. Agents it doesn't list are absent.
  roles: Map<string, { provider: ProviderConfig; model?: string }>;
  // Builder session ids by spawnAgent name, for resumeBuilder. In memory for one entry-point call.
  sessions: Map<string, string>;
}

// An event-producing action in flight. It resolves to itself so the loop can drop it from the running set.
type Task = Promise<{ task: Task; event: OrchestratorEvent }>;

export async function runJob(options: RunnerOptions, input: { id: string; feature: string }): Promise<JobState> {
  const ctx = await context(options, input.id);
  await mkdir(join(ctx.repo, "factory", "jobs"), { recursive: true });
  const folder = jobFolder(ctx.repo, ctx.id);
  try {
    await mkdir(folder);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw Object.assign(new Error(`${ctx.id}: job folder already exists: ${folder}`), { code: "EEXIST" });
    }
    throw error;
  }
  return drive(ctx, startJob({ id: ctx.id, feature: input.feature, repo: ctx.repo }));
}

export async function approveJob(options: RunnerOptions, id: string): Promise<JobState> {
  const ctx = await context(options, id);
  const state = await loadState(ctx);
  return drive(ctx, transition(state, { type: "approve" }));
}

export async function reworkJob(options: RunnerOptions, id: string, note: string): Promise<JobState> {
  const ctx = await context(options, id);
  const state = await loadState(ctx);
  const k = nextReworkNumber(await readdir(jobFolder(ctx.repo, ctx.id)));
  return drive(ctx, transition(state, { type: "rework", note, k }));
}

async function context(options: RunnerOptions, id: string): Promise<Context> {
  if (!isValidJobId(id)) throw new Error(`Invalid job id: ${JSON.stringify(id)}`);
  const repo = resolve(options.repo);
  const agents = await loadAgents(repo);
  return { repo, id, options, agents, roles: await loadRoles(repo, agents), sessions: new Map() };
}

// Agent definitions come from the main checkout, so a job branch cannot change its own agents.
async function loadAgents(repo: string): Promise<Record<string, AgentDefinition>> {
  const dir = join(repo, ".claude", "agents");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
  const files = await Promise.all(
    names.map(async (fileName) => ({ fileName, content: await readFile(join(dir, fileName), "utf8") })),
  );
  return parseAgentDirectory(files);
}

// fabrica.yaml comes from the main checkout too, so a job branch cannot change its own providers or models.
async function loadRoles(
  repo: string,
  agents: Record<string, AgentDefinition>,
): Promise<Map<string, { provider: ProviderConfig; model?: string }>> {
  const roles = new Map<string, { provider: ProviderConfig; model?: string }>();
  const file = join(repo, "fabrica.yaml");
  const content = await readIfExists(file);
  if (content === null) return roles;
  let config;
  try {
    config = parseFabricaConfig(content);
  } catch (error) {
    throw new Error(`${file}: ${errorMessage(error)}`);
  }
  for (const [name, role] of Object.entries(config.roles)) {
    if (!Object.hasOwn(agents, name)) {
      throw new Error(`${file}: role ${name} names no agent definition in ${repo}/.claude/agents/`);
    }
    // parseFabricaConfig has checked that every role names a declared provider.
    const resolved: { provider: ProviderConfig; model?: string } = { provider: config.providers[role.provider]! };
    if (role.model !== undefined) resolved.model = role.model;
    roles.set(name, resolved);
  }
  return roles;
}

async function loadState(ctx: Context): Promise<OrchestratorState> {
  const file = join(jobFolder(ctx.repo, ctx.id), "job.json");
  const job = JSON.parse(await readFile(file, "utf8")) as JobState;
  // branch and worktree reach git argv and the agents' cwd, so they must be the values startJob gives this repo and id.
  const expected = startJob({ id: ctx.id, feature: job.feature, repo: ctx.repo }).state.job;
  const reject = (field: string, value: unknown): never => {
    throw new Error(`${ctx.id}: ${file} has ${field} ${JSON.stringify(value)}`);
  };
  if (job.id !== ctx.id) reject("id", job.id);
  if (job.branch !== expected.branch) reject("branch", job.branch);
  if (job.worktree !== expected.worktree) reject("worktree", job.worktree);
  if (!Number.isInteger(job.round) || job.round < 0) reject("round", job.round);
  if (!(STAGES as readonly unknown[]).includes(job.stage)) reject("stage", job.stage);
  return stateFromJob(job, ctx.repo);
}

async function drive(ctx: Context, first: Transition): Promise<JobState> {
  let state = first.state;
  const running = new Set<Task>();
  await execute(ctx, state, first.actions, running);
  // Events are applied one at a time, in the order their actions finish.
  while (state.awaiting !== "nothing") {
    if (running.size === 0) throw new Error(`${ctx.id}: awaiting ${state.awaiting} with nothing running`);
    const { task, event } = await Promise.race(running);
    running.delete(task);
    const next = transition(state, event);
    state = next.state;
    await execute(ctx, state, next.actions, running);
  }
  // After a stop, reviewers still running are left to settle; their events are not applied.
  await Promise.allSettled(running);
  return state.job;
}

function track(running: Set<Task>, event: Promise<OrchestratorEvent>): void {
  const task: Task = event.then((result) => ({ task, event: result }));
  // A failure still reaches the loop through Promise.race; this only keeps Node from flagging it as unhandled meanwhile.
  task.catch(() => undefined);
  running.add(task);
}

// state is the state the actions were emitted with.
async function execute(ctx: Context, state: OrchestratorState, actions: Action[], running: Set<Task>): Promise<void> {
  const { repo, id, options } = ctx;
  const folder = jobFolder(repo, id);
  for (const action of actions) {
    switch (action.type) {
      case "writeJob":
        await writeJobFile(repo, id, join(folder, "job.json"), jobJson(action.job));
        break;
      case "createWorktree":
        track(running, Promise.resolve(await createWorktree(ctx, action.branch, action.worktree)));
        break;
      case "spawnAgent": {
        const call = agentCall(ctx, action.agent, action.prompt, state.job.worktree);
        track(running, callAgent(ctx, action.agent, call, outputFile(state, action.agent), action.name));
        break;
      }
      case "resumeBuilder": {
        const resume = ctx.sessions.get(action.name);
        if (resume === undefined) throw new Error(`${id}: no session to resume for ${action.name}`);
        const call = { ...agentCall(ctx, "builder", action.message, state.job.worktree), resume };
        track(running, callAgent(ctx, "builder", call, outputFile(state, "builder")));
        break;
      }
      case "createDir":
        await createJobDir(repo, id, action.path);
        break;
      case "writeFile":
        await writeJobFile(repo, id, action.path, action.content);
        break;
      case "checkMainCheckout":
        track(running, Promise.resolve(await checkMainCheckout(ctx)));
        break;
      case "merge": {
        const merge = await git(["merge", "--no-ff", "-m", action.message, "--end-of-options", action.branch], repo);
        const event: OrchestratorEvent = merge.ok
          ? { type: "mergeDone", ok: true }
          : {
              type: "mergeDone",
              ok: false,
              error: merge.error,
              inProgress: (await git(["rev-parse", "-q", "--verify", "--end-of-options", "MERGE_HEAD"], repo)).ok,
            };
        track(running, Promise.resolve(event));
        break;
      }
      case "abortMerge": {
        const abort = await git(["merge", "--abort"], repo);
        if (!abort.ok) options.notify(`${id}: git merge --abort failed: ${abort.error}`);
        break;
      }
      case "removeWorktree": {
        const remove = await git(["worktree", "remove", "--end-of-options", action.worktree], repo);
        const output = remove.ok ? `${remove.stdout}${remove.stderr}`.trim() : remove.error;
        track(running, Promise.resolve({ type: "worktreeRemoved", ok: remove.ok, output }));
        break;
      }
      case "deleteBranch": {
        const remove = await git(["branch", "-d", "--end-of-options", action.branch], repo);
        if (!remove.ok) options.notify(`${id}: git branch -d ${action.branch} failed: ${remove.error}`);
        break;
      }
      case "notify":
        options.notify(action.message);
        break;
    }
  }
}

function jobJson(job: JobState): string {
  const { id, feature, branch, worktree, stage, round, reviews } = job;
  return `${JSON.stringify({ id, feature, branch, worktree, stage, round, reviews }, null, 2)}\n`;
}

function definition(ctx: Context, agent: AgentName): AgentDefinition {
  const found = ctx.agents[agent];
  if (!found) throw new Error(`${ctx.id}: no agent definition named ${agent} in ${ctx.repo}/.claude/agents/`);
  return found;
}

// A call with the agent's definition, plus its provider and model when fabrica.yaml lists its role.
function agentCall(ctx: Context, agent: AgentName, prompt: string, cwd: string): AgentCall {
  return { agent: definition(ctx, agent), prompt, cwd, ...ctx.roles.get(agent) };
}

// The file each agent writes in the job folder. A reviewer's round is the round it was spawned in.
function outputFile(state: OrchestratorState, agent: AgentName): string {
  const folder = jobFolder(state.repo, state.job.id);
  switch (agent) {
    case "spec-writer":
      return join(folder, "spec.md");
    case "builder":
      return join(folder, "build.md");
    case "approver":
      return join(folder, "decision.md");
    default:
      return join(folder, `round-${state.job.round}`, `${agent.replace(/^reviewer-/, "review-")}.md`);
  }
}

async function callAgent(
  ctx: Context,
  agent: AgentName,
  call: AgentCall,
  file: string,
  name?: string,
): Promise<OrchestratorEvent> {
  try {
    const { sessionId } = await ctx.options.executor(call);
    if (name !== undefined) ctx.sessions.set(name, sessionId);
  } catch (error) {
    ctx.options.notify(`${ctx.id}: ${agent} failed: ${errorMessage(error)}`);
  }
  return { type: "agentDone", agent, content: await readIfExists(file) };
}

async function createWorktree(ctx: Context, branch: string, worktree: string): Promise<OrchestratorEvent> {
  const add = await git(["worktree", "add", "-b", branch, "--end-of-options", worktree, "main"], ctx.repo);
  if (!add.ok) return { type: "worktreeCreated", ok: false, error: add.error };
  const [command, ...args] = ctx.options.setup ?? [];
  if (command !== undefined) {
    const setup = await run(command, args, worktree);
    if (!setup.ok) return { type: "worktreeCreated", ok: false, error: setup.error };
  }
  return { type: "worktreeCreated", ok: true };
}

async function checkMainCheckout(ctx: Context): Promise<OrchestratorEvent> {
  const status = await git(["status", "--porcelain", "--", ".", ":!factory/backlog.md"], ctx.repo);
  if (!status.ok) throw new Error(`${ctx.id}: git status failed in ${ctx.repo}: ${status.error}`);
  const branch = await git(["branch", "--show-current"], ctx.repo);
  if (!branch.ok) throw new Error(`${ctx.id}: git branch --show-current failed in ${ctx.repo}: ${branch.error}`);
  return { type: "mainCheckout", porcelain: status.stdout, branch: branch.stdout.trim() };
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
