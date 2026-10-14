# AGENTS.md

Fabrica is a software factory: a spec → build → 4 parallel reviews → approve
loop run by Claude agents. Today it runs as a Claude Code skill
(`.claude/skills/factory/SKILL.md` + `.claude/agents/*.md`). We are turning it
into a self-hosted product for dev teams. **Read `docs/ROADMAP.md` before any
work**: it is the plan every job implements a piece of.

## Layout

```
.claude/skills/factory/SKILL.md  the orchestrator spec (the source of truth for loop behaviour)
.claude/agents/*.md              the 7 agents: frontmatter (name, description, tools, model) + prompt body
factory/                         local factory runtime: backlog.md, dashboard.html, jobs/ (gitignored)
docs/ROADMAP.md                  product plan and architecture
packages/core/                   @fabrica/core: types and pure logic (no I/O)
                                 (job state types, first-line contract parsers, agent file parsing from contents with a tool allowlist,
                                 fabrica.yaml provider config parsing from contents,
                                 orchestrator state machine: transition(state, event) → actions for a runner, plus prompts and ports)
apps/                            runnable apps (runner, cli) as they are added
apps/runner/                     @fabrica/runner: the local runner that executes core's actions on the host (git worktrees, Agent SDK agents, job.json)
apps/cli/                        @fabrica/cli: the fabrica command (run, next, approve, rework, status) driving apps/runner, run from sources through tsx
```

- `packages/*` and `apps/*` are pnpm workspace packages. Each has a
  `package.json` named `@fabrica/<name>` with `"type": "module"` and
  `"exports": { ".": "./src/index.ts" }`. Source lives in `src/`, tests sit
  next to the code as `*.test.ts`.
- `packages/core` stays pure: no filesystem, network, process or git access.
  I/O lives in `apps/`.
- When porting behaviour from `SKILL.md`, keep its names (stages, `MAX_RESUMES`,
  prompts, ports) so the two stay easy to compare. Don't change `SKILL.md` or the
  agent files unless the spec says so: the local skill must keep working.

## Setup (fresh checkout)

Requires Node 24+ and pnpm.

```bash
pnpm install
```

## Validation

```bash
pnpm typecheck   # tsc --noEmit over packages/*/src and apps/*/src
pnpm test        # vitest run
pnpm check       # both; must pass before every commit
```

There is no linter or formatter yet; match the surrounding style (2-space
indent, double quotes, semicolons, ES modules, `import type` for types).

## CLI

`apps/cli` mirrors the `/factory` commands in `SKILL.md`:

```bash
fabrica run <feature...>            # /factory <feature>
fabrica next                        # /factory next
fabrica approve <job-id>            # /factory approve <job-id>
fabrica rework <job-id> <note...>   # /factory rework <job-id> <note>
fabrica status                      # one line per job in factory/jobs/
```

Run it from inside the target repo (the repo is `git rev-parse --show-toplevel`
of the current directory) as `node <fabrica>/apps/cli/bin/fabrica.js <command>`,
or as `fabrica <command>` once linked, for example with
`pnpm --filter @fabrica/cli link --global`. The CLI runs no setup command in new
worktrees: dependencies are not installed there, unlike `SKILL.md` step 2.

## Dev server

None yet. There are no pages to look at, so there is nothing for
`agent-browser` to check. `factory/dashboard.html` is the existing static
board (`cd factory && python3 -m http.server`).

## Model providers

`fabrica.yaml` at the repo root of the main checkout picks the provider and
model for each agent role. Only `apps/runner` reads it, never from a job
worktree. Without the file, or for a role it doesn't list, agents use their
frontmatter `model` and the runner's environment. A role's `model` is optional
and falls back to the frontmatter. See `fabrica.example.yaml`:

```yaml
providers:
  api:            { type: anthropic }
  claude-bedrock: { type: bedrock, region: us-east-1 }
  claude-vertex:  { type: vertex, project: acme, region: us-east5 }
  gateway:        { type: anthropic-compatible, base_url: https://litellm:4000 }
roles:
  builder:     { provider: claude-bedrock, model: claude-opus-5-5 }
  reviewer-ux: { provider: gateway, model: qwen3-coder }
```

Credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, the AWS credential
chain, GCP ADC) come from the runner's environment, never from the file.
An `anthropic-compatible` gateway receives the runner's `ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN`, so its `base_url` must be `https:` and may not contain
`user:pass@`.

## Conventions

- TypeScript strict mode, no `any`. Prefer plain functions and data over classes.
- Add a dependency only when the spec calls for it. Use exact package names
  from npm and add them to the package that uses them.
- Tests use vitest. Unit tests must not call real models, the network or real
  git remotes. Use fakes or temp directories.
- Commits: short one-line messages, imperative mood.
