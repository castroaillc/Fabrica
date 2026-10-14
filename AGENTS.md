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
apps/                            runnable apps (runner, cli) as they are added
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

## Dev server

None yet. There are no pages to look at, so there is nothing for
`agent-browser` to check. `factory/dashboard.html` is the existing static
board (`cd factory && python3 -m http.server`).

## Conventions

- TypeScript strict mode, no `any`. Prefer plain functions and data over classes.
- Add a dependency only when the spec calls for it. Use exact package names
  from npm and add them to the package that uses them.
- Tests use vitest. Unit tests must not call real models, the network or real
  git remotes. Use fakes or temp directories.
- Commits: short one-line messages, imperative mood.
