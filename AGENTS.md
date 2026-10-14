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
apps/runner/                     @fabrica/runner: the local runner that executes core's actions on the host (git worktrees, Agent SDK agents, job.json),
                                 plus the Postgres job queue (pg-boss) and job store a worker resumes jobs from
apps/cli/                        @fabrica/cli: the fabrica command (run, next, approve, rework, status) driving apps/runner, run from sources through tsx
apps/web/                        @fabrica/web: Next.js web app (Carbon, Better Auth, Drizzle on Postgres); the dashboard shows placeholder jobs
turbo.json                       Turborepo tasks (build, dev, typecheck, clean) run by the root scripts
docker-compose.yml               dev Postgres 17 for apps/web and the runner's queue and job store (user, password and database `fabrica`)
```

- `packages/*` and `apps/*` are pnpm workspace packages. Each has a
  `package.json` named `@fabrica/<name>` with `"type": "module"` and
  `"exports": { ".": "./src/index.ts" }`. Source lives in `src/`, tests sit
  next to the code as `*.test.ts`.
- `apps/web` is the exception: it is a Next.js app with `app/`, `components/`
  and `lib/` at the package root, no `src/` and no `exports`. It has its own
  `tsconfig.json` and TypeScript version, and is typechecked through turbo,
  not by the root tsconfig.
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
pnpm typecheck   # tsc --noEmit over packages/*/src and apps/*/src, then turbo run typecheck (apps/web: next typegen && tsc --noEmit)
pnpm test        # vitest run
pnpm check       # both; must pass before every commit
pnpm build       # turbo run build (next build for apps/web; needs apps/web/.env, see Dev server)
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
fabrica worker                      # run queued jobs for this repo until SIGINT/SIGTERM (needs DATABASE_URL)
```

With `DATABASE_URL` set, `run` and `next` don't run the job: they create it
(`job.json` at stage `spec`), save it to the job store, enqueue it, print
`<id>: queued` and exit. A `fabrica worker` started in the same repo picks it
up. `approve` and `rework` still run in-process and also update the job store.
Without `DATABASE_URL` every command runs in-process as before.

Run it from inside the target repo (the repo is `git rev-parse --show-toplevel`
of the current directory) as `node <fabrica>/apps/cli/bin/fabrica.js <command>`,
or as `fabrica <command>` once linked, for example with
`pnpm --filter @fabrica/cli link --global`. The CLI runs no setup command in new
worktrees: dependencies are not installed there, unlike `SKILL.md` step 2.

## Dev server

The web app in `apps/web` needs Postgres (Docker) and an `.env`:

1. `docker compose up -d` (Postgres 17 on localhost:5432)
2. `cp apps/web/.env.example apps/web/.env` and set `BETTER_AUTH_SECRET`
   (for example with `openssl rand -base64 32`)
3. `pnpm --filter @fabrica/web db:migrate`
4. `pnpm --filter @fabrica/web dev`, which serves on port 3000. For another
   port run `pnpm --filter @fabrica/web exec next dev --port <port>` and set
   `BETTER_AUTH_URL` in `apps/web/.env` to `http://localhost:<port>` to match.

Pages can now be checked with `agent-browser`: `/` (welcome), `/sign-in`
(email and password; "New here?" switches to sign-up) and `/dashboard`
(signed-in only, redirects to `/sign-in`). `factory/dashboard.html` is still
the static factory board (`cd factory && python3 -m http.server`).

## Job queue

The runner's queue is pg-boss on the dev Postgres from `docker-compose.yml`,
reached through `DATABASE_URL` (for example
`postgres://fabrica:fabrica@127.0.0.1:5432/fabrica`). The runner's tables live
in two schemas of their own, never in `public` with apps/web's tables:
`fabrica_queue` (pg-boss creates and migrates it) and `fabrica_runner` (the
`jobs` table: state, in-flight actions and builder session ids per job,
created on first use).

There is one queue per repo, and a worker only runs jobs for the repo it was
started in, one at a time. The runner saves the job after every step, so jobs
survive a restart: a worker that dies stops sending heartbeats, pg-boss fails
the job within a minute or two and retries it (up to 3 times), and the next
worker carries on from the saved step. Steps run at least once: an agent that
was running when the worker died runs again, and a resumed builder resumes its
saved SDK session.

The Postgres tests in `apps/runner/src/postgres.test.ts` are skipped unless
`DATABASE_URL` points at `localhost`, `127.0.0.1` or `::1`. To run them:

```bash
docker compose up -d
DATABASE_URL=postgres://fabrica:fabrica@127.0.0.1:5432/fabrica pnpm test
```

They use their own throwaway schemas and drop them afterwards.

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
  gateway:        { type: anthropic-compatible, base_url: http://localhost:4000 }
roles:
  builder:     { provider: claude-bedrock, model: claude-opus-5-5 }
  reviewer-ux: { provider: gateway, model: qwen3-coder }
```

Credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, the AWS credential
chain, GCP ADC) come from the runner's environment, never from the file.
An `anthropic-compatible` gateway receives the runner's `ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN`, so its `base_url` must be `https:` (plain `http:` only
for `localhost`, `127.0.0.1` or `[::1]`) and may not contain `user:pass@`.

## Conventions

- TypeScript strict mode, no `any`. Prefer plain functions and data over classes.
- Add a dependency only when the spec calls for it. Use exact package names
  from npm and add them to the package that uses them.
- Tests use vitest. Unit tests must not call real models, the network or real
  git remotes. Use fakes or temp directories.
- Commits: short one-line messages, imperative mood.
