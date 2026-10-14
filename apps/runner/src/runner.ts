// Executes core's orchestrator actions on the host: git worktrees, agents through an AgentExecutor, job.json.
// Each entry point runs actions in order and feeds every outcome back through transition until awaiting "nothing".
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MAX_RESUMES,
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
  Awaiting,
  JobState,
  OrchestratorEvent,
  OrchestratorState,
  ProviderConfig,
  Transition,
} from "@fabrica/core";
import type { AgentCall, AgentExecutor } from "./executor.js";
import { git, run } from "./git.js";
import { createJobDir, isValidJobId, jobFolder, writeJobFile } from "./jobFolder.js";
import type { JobStore, SavedJob } from "./jobStore.js";
import type { JobQueue } from "./queue.js";

export interface RunnerOptions {
  repo: string;
  executor: AgentExecutor;
  notify: (message: string) => void;
  setup?: string[];
  // When set, drive saves the state and in-flight actions after every step, and builder session ids as they arrive.
  store?: JobStore;
  // Called after a successful removeWorktree, for example to remove the job's container in Docker mode.
  teardown?: (id: string) => Promise<void>;
  // Docker mode: agents can write the repo's git dir, so host git runs with fsmonitor and hooks turned off.
  hardenGit?: boolean;
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
  // Resolves once drive has saved the job's row, so saveSession never runs before the row exists.
  saved: Promise<void>;
  markSaved: () => void;
  // Set by resumeJob: in-flight actions are being run again after a restart.
  resumed: boolean;
}

// An event-producing action in flight. It resolves to itself so the loop can drop it from the running set.
type Task = Promise<{ task: Task; event: OrchestratorEvent }>;

// The actions answered by an event; the others are side effects only.
const EVENT_ACTIONS: ReadonlySet<string> = new Set<Action["type"]>([
  "createWorktree",
  "spawnAgent",
  "resumeBuilder",
  "checkMainCheckout",
  "merge",
  "removeWorktree",
]);

const AWAITING: Record<Awaiting, true> = {
  worktree: true,
  "spec-writer": true,
  builder: true,
  reviewers: true,
  approver: true,
  "main-checkout": true,
  merge: true,
  "worktree-remove": true,
  nothing: true,
};

export async function runJob(options: RunnerOptions, input: { id: string; feature: string }): Promise<JobState> {
  const ctx = await context(options, input.id);
  await reserveJobFolder(ctx);
  return drive(ctx, startJob({ id: ctx.id, feature: input.feature, repo: ctx.repo }));
}

// Creates the job the way runJob does, but leaves the running to a worker: job.json, the saved row, then one queue message.
export async function enqueueJob(
  options: RunnerOptions,
  queue: JobQueue,
  input: { id: string; feature: string },
): Promise<JobState> {
  const store = requireStore(options);
  const ctx = await context(options, input.id);
  await reserveJobFolder(ctx);
  const { state, actions } = startJob({ id: ctx.id, feature: input.feature, repo: ctx.repo });
  await writeJobFile(ctx.repo, ctx.id, join(jobFolder(ctx.repo, ctx.id), "job.json"), jobJson(state.job));
  await store.save(ctx.repo, ctx.id, { feature: input.feature, state, inFlight: actions.filter(isEventAction) });
  await queue.send({ repo: ctx.repo, id: ctx.id });
  return state.job;
}

// Drives a saved job on from its row: rewrites job.json, then runs the in-flight actions again (at least once).
export async function resumeJob(options: RunnerOptions, id: string): Promise<JobState> {
  const store = requireStore(options);
  const ctx = await context(options, id);
  const saved = await store.load(ctx.repo, ctx.id);
  if (saved === null) throw new Error(`${ctx.id}: no saved job for ${ctx.repo}`);
  const state = savedState(ctx, saved);
  if (state.awaiting === "nothing") return state.job;
  for (const [name, sessionId] of Object.entries(saved.sessions)) ctx.sessions.set(name, sessionId);
  ctx.resumed = true;
  return drive(ctx, { state, actions: [{ type: "writeJob", job: state.job }, ...saved.inFlight] });
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
  const roles = await loadRoles(repo, agents);
  let markSaved = (): void => undefined;
  const saved = new Promise<void>((done) => (markSaved = done));
  return { repo, id, options, agents, roles, sessions: new Map(), saved, markSaved, resumed: false };
}

function requireStore(options: RunnerOptions): JobStore {
  if (options.store === undefined) throw new Error("This needs a job store (RunnerOptions.store)");
  return options.store;
}

// Reserves the id: the folder's mkdir fails with EEXIST when another session took it.
async function reserveJobFolder(ctx: Context): Promise<void> {
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
  checkJob(ctx, job, file);
  return stateFromJob(job, ctx.repo);
}

function rejecter(ctx: Context, source: string): (field: string, value: unknown) => never {
  return (field, value) => {
    throw new Error(`${ctx.id}: ${source} has ${field} ${JSON.stringify(value)}`);
  };
}

// branch and worktree reach git argv and the agents' cwd, so they must be the values startJob gives this repo and id.
function checkJob(ctx: Context, job: JobState, source: string): void {
  const reject = rejecter(ctx, source);
  if (typeof job !== "object" || job === null) reject("job", job);
  const expected = startJob({ id: ctx.id, feature: job.feature, repo: ctx.repo }).state.job;
  if (job.id !== ctx.id) reject("id", job.id);
  if (job.branch !== expected.branch) reject("branch", job.branch);
  if (job.worktree !== expected.worktree) reject("worktree", job.worktree);
  if (!Number.isInteger(job.round) || job.round < 0) reject("round", job.round);
  if (!(STAGES as readonly unknown[]).includes(job.stage)) reject("stage", job.stage);
}

// A saved row is checked like job.json, and its in-flight actions may only be event-producing ones on the job's branch and worktree.
function savedState(ctx: Context, saved: SavedJob): OrchestratorState {
  const source = "the saved state";
  const reject = rejecter(ctx, source);
  const { state, inFlight, sessions } = saved;
  if (typeof state !== "object" || state === null) reject("state", state);
  if (state.repo !== ctx.repo) reject("repo", state.repo);
  checkJob(ctx, state.job, source);
  if (typeof state.awaiting !== "string" || !Object.hasOwn(AWAITING, state.awaiting)) reject("awaiting", state.awaiting);
  if (!Number.isInteger(state.resumes) || state.resumes < 0 || state.resumes > MAX_RESUMES) {
    reject("resumes", state.resumes);
  }
  if (!Array.isArray(inFlight)) reject("in-flight actions", inFlight);
  for (const action of inFlight) {
    if (!isEventAction(action)) reject("in-flight action", action);
    if ("branch" in action && action.branch !== state.job.branch) reject("in-flight branch", action.branch);
    if ("worktree" in action && action.worktree !== state.job.worktree) reject("in-flight worktree", action.worktree);
  }
  if (typeof sessions !== "object" || sessions === null || Object.values(sessions).some((s) => typeof s !== "string")) {
    reject("sessions", sessions);
  }
  return state;
}

function isEventAction(action: Action): boolean {
  return typeof action === "object" && action !== null && EVENT_ACTIONS.has(action.type);
}

async function drive(ctx: Context, first: Transition): Promise<JobState> {
  let state = first.state;
  // Each running task with the action it answers.
  const running = new Map<Task, Action>();
  await execute(ctx, state, first.actions, running);
  await save(ctx, state, running);
  // Events are applied one at a time, in the order their actions finish.
  while (state.awaiting !== "nothing") {
    if (running.size === 0) throw new Error(`${ctx.id}: awaiting ${state.awaiting} with nothing running`);
    const { task, event } = await Promise.race(running.keys());
    running.delete(task);
    const next = transition(state, event);
    state = next.state;
    await execute(ctx, state, next.actions, running);
    await save(ctx, state, running);
  }
  // After a stop, reviewers still running are left to settle; their events are not applied.
  await Promise.allSettled(running.keys());
  return state.job;
}

// With a store, the row holds the state and the actions whose events are not applied yet, for resumeJob.
async function save(ctx: Context, state: OrchestratorState, running: Map<Task, Action>): Promise<void> {
  const store = ctx.options.store;
  if (store === undefined) return;
  await store.save(ctx.repo, ctx.id, { feature: state.job.feature, state, inFlight: [...running.values()] });
  ctx.markSaved();
}

function track(running: Map<Task, Action>, action: Action, event: Promise<OrchestratorEvent>): void {
  const task: Task = event.then((result) => ({ task, event: result }));
  // A failure still reaches the loop through Promise.race; this only keeps Node from flagging it as unhandled meanwhile.
  task.catch(() => undefined);
  running.set(task, action);
}

// state is the state the actions were emitted with.
async function execute(
  ctx: Context,
  state: OrchestratorState,
  actions: Action[],
  running: Map<Task, Action>,
): Promise<void> {
  const { repo, id, options } = ctx;
  const folder = jobFolder(repo, id);
  for (const action of actions) {
    switch (action.type) {
      case "writeJob":
        await writeJobFile(repo, id, join(folder, "job.json"), jobJson(action.job));
        break;
      case "createWorktree":
        track(running, action, Promise.resolve(await createWorktree(ctx, action.branch, action.worktree)));
        break;
      case "spawnAgent": {
        const call = agentCall(ctx, action.agent, action.prompt, state.job.worktree);
        track(running, action, callAgent(ctx, action.agent, call, outputFile(state, action.agent), action.name));
        break;
      }
      case "resumeBuilder": {
        const resume = ctx.sessions.get(action.name);
        if (resume === undefined) throw new Error(`${id}: no session to resume for ${action.name}`);
        const call = { ...agentCall(ctx, "builder", action.message, state.job.worktree), resume };
        track(running, action, callAgent(ctx, "builder", call, outputFile(state, "builder")));
        break;
      }
      case "createDir":
        await createJobDir(repo, id, action.path);
        break;
      case "writeFile":
        await writeJobFile(repo, id, action.path, action.content);
        break;
      case "checkMainCheckout":
        track(running, action, Promise.resolve(await checkMainCheckout(ctx)));
        break;
      case "merge": {
        const mergeHead = ["rev-parse", "-q", "--verify", "--end-of-options", "MERGE_HEAD"];
        const merge = await hostGit(
          options,
          ["merge", "--no-ff", "-m", action.message, "--end-of-options", action.branch],
          repo,
        );
        const event: OrchestratorEvent = merge.ok
          ? { type: "mergeDone", ok: true }
          : {
              type: "mergeDone",
              ok: false,
              error: merge.error,
              inProgress: (await hostGit(options, mergeHead, repo)).ok,
            };
        track(running, action, Promise.resolve(event));
        break;
      }
      case "abortMerge": {
        const abort = await hostGit(options, ["merge", "--abort"], repo);
        if (!abort.ok) options.notify(`${id}: git merge --abort failed: ${abort.error}`);
        break;
      }
      case "removeWorktree": {
        const remove = await hostGit(options, ["worktree", "remove", "--end-of-options", action.worktree], repo);
        const output = remove.ok ? `${remove.stdout}${remove.stderr}`.trim() : remove.error;
        if (remove.ok && options.teardown !== undefined) {
          try {
            await options.teardown(id);
          } catch (error) {
            options.notify(`${id}: teardown failed: ${errorMessage(error)}`);
          }
        }
        track(running, action, Promise.resolve({ type: "worktreeRemoved", ok: remove.ok, output }));
        break;
      }
      case "deleteBranch": {
        const remove = await hostGit(options, ["branch", "-d", "--end-of-options", action.branch], repo);
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

// A call with the agent's definition, the job's id and folder, plus its provider and model when fabrica.yaml lists
// its role.
function agentCall(ctx: Context, agent: AgentName, prompt: string, cwd: string): AgentCall {
  const folder = jobFolder(ctx.repo, ctx.id);
  return { agent: definition(ctx, agent), prompt, cwd, jobId: ctx.id, jobFolder: folder, ...ctx.roles.get(agent) };
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
  let sessionId: string | undefined;
  try {
    ({ sessionId } = await ctx.options.executor(call));
  } catch (error) {
    ctx.options.notify(`${ctx.id}: ${agent} failed: ${errorMessage(error)}`);
  }
  if (name !== undefined && sessionId !== undefined) {
    ctx.sessions.set(name, sessionId);
    const store = ctx.options.store;
    if (store !== undefined) {
      await ctx.saved;
      await store.saveSession(ctx.repo, ctx.id, name, sessionId);
    }
  }
  return { type: "agentDone", agent, content: await readIfExists(file) };
}

async function createWorktree(ctx: Context, branch: string, worktree: string): Promise<OrchestratorEvent> {
  if (!(ctx.resumed && (await hasWorktree(ctx, branch, worktree)))) {
    const add = await hostGit(
      ctx.options,
      ["worktree", "add", "-b", branch, "--end-of-options", worktree, "main"],
      ctx.repo,
    );
    if (!add.ok) return { type: "worktreeCreated", ok: false, error: add.error };
  }
  const [command, ...args] = ctx.options.setup ?? [];
  if (command !== undefined) {
    const setup = await run(command, args, worktree);
    if (!setup.ok) return { type: "worktreeCreated", ok: false, error: setup.error };
  }
  return { type: "worktreeCreated", ok: true };
}

// After a restart, a worktree registered at worktree on branch means git worktree add already ran.
async function hasWorktree(ctx: Context, branch: string, worktree: string): Promise<boolean> {
  const list = await hostGit(ctx.options, ["worktree", "list", "--porcelain"], ctx.repo);
  if (!list.ok) return false;
  return list.stdout.split("\n\n").some((block) => {
    const lines = block.split("\n");
    return lines.includes(`worktree ${worktree}`) && lines.includes(`branch refs/heads/${branch}`);
  });
}

async function checkMainCheckout(ctx: Context): Promise<OrchestratorEvent> {
  const status = await hostGit(ctx.options, ["status", "--porcelain", "--", ".", ":!factory/backlog.md"], ctx.repo);
  if (!status.ok) throw new Error(`${ctx.id}: git status failed in ${ctx.repo}: ${status.error}`);
  const branch = await hostGit(ctx.options, ["branch", "--show-current"], ctx.repo);
  if (!branch.ok) throw new Error(`${ctx.id}: git branch --show-current failed in ${ctx.repo}: ${branch.error}`);
  return { type: "mainCheckout", porcelain: status.stdout, branch: branch.stdout.trim() };
}

const HARDENED_GIT: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

// Git passes -c settings on to the git processes it starts, so they cover worktree remove's status check too.
function hostGit(options: RunnerOptions, args: readonly string[], cwd: string) {
  return git(options.hardenGit ? [...HARDENED_GIT, ...args] : args, cwd);
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
