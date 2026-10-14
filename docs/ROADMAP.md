# Fabrica → self-hosted software factory for dev teams

## Context

Fabrica today is a local Claude Code kit: one orchestrator skill (`.claude/skills/factory/SKILL.md`), seven subagents (`.claude/agents/*.md`), markdown and `job.json` for state under `factory/jobs/`, one git worktree per job, and a static `factory/dashboard.html` that polls the files. It runs only inside one developer's Claude Code session, on one machine, with Anthropic models.

The goal is a **product dev teams install on their own machines or cloud**. Teams point it at their GitHub repos and their own model endpoints, and get a shared factory: issues in, reviewed PRs out. Decisions so far:
- **Models:** Claude via the Anthropic API, Bedrock, Vertex or Foundry, used natively through the Claude Agent SDK. Any other model goes through an Anthropic-compatible gateway (LiteLLM), chosen per agent role.
- **Business:** open core. The factory is open source, and a paid Enterprise license unlocks team and governance features.
- **Git host for v1:** GitHub.com and GitHub Enterprise Server.

What stays unchanged, because it is the product's core: the loop (spec → build → 4 parallel reviews → WAIT FOR ALL → approver), the one-file-per-agent contract with `VERDICT:` and `APPROVE`/`ESCALATE` first lines, the resume-the-same-builder rule, `MAX_RESUMES = 2`, and agents that carry nothing repo-specific and read `AGENTS.md`/`CLAUDE.md`.

## How a team uses it

1. An admin runs `docker compose up` (or `helm install`), opens the web UI and creates a GitHub App through the manifest flow, which works on GHES. They install the App on the repos they choose, configure model providers, and invite the team.
2. **Triggers:** add the `fabrica` label to an issue, comment `/fabrica <feature>` on an issue, use the web UI, or call `fabrica run "<feature>"` from the CLI. The backlog becomes a GitHub issue query or project column instead of `backlog.md`.
3. The job runs in an isolated container. The board updates live, the issue gets a status comment, and every reviewer verdict appears as a **GitHub check run** on the PR.
4. **Output is a PR.** APPROVE marks the PR ready, and auto-merges it only if repo policy allows. ESCALATE turns it into a PR that requests review from CODEOWNERS.
5. **Human loop through GitHub.** Merging the PR replaces `/factory approve`. A PR comment `/fabrica rework <note>` replaces `/factory rework`.
6. The existing local Claude Code skill remains as **"Fabrica local"**. It uses the same agent files and the same repo config, so developers can run jobs on their laptop with no server.

## Architecture

```
fabrica/
  apps/server     API + web UI (board, jobs, settings, admin); GitHub webhook receiver
  apps/runner     pulls jobs, runs the orchestrator state machine, launches job containers
  apps/cli        `fabrica run|status|approve|rework|eval|doctor`
  packages/core   Job/Round/Review types, stage enum, verdict parsing, policy schema
  packages/agents the 7 agent .md files (default "agent pack")
  images/job      base job container: git, node/python toolchains, agent-browser, Agent SDK
  deploy/         docker-compose.yml, Helm chart, Terraform examples (AWS/GCP)
  skill/          the current .claude/ kit, kept as Fabrica local
```

**Orchestrator in code.** Port `SKILL.md` into a typed state machine in `apps/runner`. Its stages (`spec, build, review, approve, merged, needs-human`), transitions, WAIT FOR ALL join, round limits and failure handling are already fully specified there, so this is a transcription. Doing it in code makes the orchestrator deterministic, resumable after crashes, cheaper, and testable without an LLM.

**Few dependencies for self-hosters.** Postgres is the only required stateful service. Use a Postgres-backed job queue (pg-boss or graphile-worker) instead of Temporal or Redis. Store artifacts in Postgres, with optional S3 or GCS for screenshots and logs.

**Runners.** Runners scale horizontally. Each one claims jobs from the queue and launches one container per job:
- **Docker mode** (one VM): the runner talks to the Docker socket. gVisor is optional for stronger isolation.
- **Kubernetes mode:** each job is a k8s `Job` or pod, with resource limits and a NetworkPolicy for egress.
- Each container clones the repo to `factory/<job-id>` (replacing local worktrees), runs `AGENTS.md` setup, and is torn down after the PR is merged, closed or goes stale. Per-job ports from SKILL.md become unnecessary.
- Teams can provide their own job image, built `FROM fabrica/job`, for their toolchain.

**Agents via the Claude Agent SDK.** Each step is an SDK `query()` inside the job container:
- The system prompt comes from the agent `.md` body. `tools` and `model` come from the frontmatter, and the role-to-model mapping can be overridden by config.
- The builder's SDK session ID is persisted, so "resume the same builder" works across rounds, including after a runner restart.
- Agents still write their markdown files. The runner streams each file to Postgres when it appears and parses its first line for the verdict, exactly as the skill does today.

**Models: provider config per agent role** (in `fabrica.yaml` or the admin UI):
```yaml
providers:
  claude-bedrock: { type: bedrock, region: us-east-1 }       # CLAUDE_CODE_USE_BEDROCK
  claude-vertex:  { type: vertex, project: acme, region: us-east5 }
  gateway:        { type: anthropic-compatible, base_url: http://litellm:4000 }  # ANTHROPIC_BASE_URL
roles:
  spec-writer:       { provider: claude-bedrock, model: claude-opus-5-5 }
  builder:           { provider: claude-bedrock, model: claude-opus-5-5 }
  reviewer-security: { provider: claude-bedrock, model: claude-opus-5-5 }
  reviewer-ux:       { provider: gateway, model: qwen3-coder }   # e.g. local vLLM
```
- The Docker Compose file can bundle a LiteLLM profile for teams using OpenAI or local models. **Fully air-gapped** setups need a local model behind the gateway plus a mirrored job image and package registry.
- **`fabrica eval`** runs a bundled suite of feature tasks against a role/model pair and reports pass rate, rounds, cost and time. Teams use it to qualify a non-Claude model for a role before trusting it. This matters because tool-use quality varies a lot across models.

**Repo-level config** lives in `.fabrica/` in each repo and falls back to defaults:
- `policy.yaml` sets: max rounds, per-job token or cost budget, auto-merge on or off, paths that force ESCALATE (migrations, CI, infra, auth), required reviewers, and which branches jobs may target.
- `agents/` holds overrides or extra reviewer lenses (for example `reviewer-perf.md`). Reviewers are discovered as a list, not hardcoded to four. That requires generalising the `reviews` map in the stage model and the WAIT FOR ALL join.
- `AGENTS.md`/`CLAUDE.md` stay the source of repo instructions, as today.

**Web UI.** Rebuild `factory/dashboard.html` as the board, keeping its stage columns, round chips and click-to-read markdown. Push live updates over SSE instead of polling. Add views for jobs across repos, job detail (artifacts, logs, diff link, cost), settings (providers, repos, policies) and an audit log.

**Observability.** OpenTelemetry traces for each job, step and agent call. Prometheus metrics for jobs by stage, pass rates, rounds and tokens or cost per model. Structured logs. A cost view per repo and per team, so platform teams can see spend on their own model bills.

## Security posture (the selling point of self-hosting)

- Code never leaves the customer's infrastructure except to the model endpoints they configure.
- Job containers have no access to the server's database or secrets. Each gets a short-lived, repo-scoped GitHub App installation token, and egress is limited to an allowlist (git host, model endpoints, package registries).
- Repo secrets for tests come from a per-repo secret store (encrypted at rest, or a reference to Vault or AWS Secrets Manager). They are injected as environment variables and never into prompts.
- Issue and PR text reaches agents as untrusted data. Only users with write access to the repo can start jobs or reworks.
- Auto-merge is off by default, and branch protection is respected. Fabrica never force-pushes or pushes to the default branch.

## Open core split

| Open source (Apache-2.0) | Enterprise (license key, offline-verifiable signed JWT) |
| --- | --- |
| Orchestrator, runners (Docker + k8s), CLI, local skill | SSO (OIDC/SAML), SCIM, RBAC (who can trigger, rework or approve per repo) |
| All agents, custom reviewer lenses, `.fabrica/` policies | Org-wide policy packs and enforced guardrails |
| GitHub App, web board, single-team use | Multi-team and multi-org, cost allocation and chargeback |
| Any model provider, `fabrica eval` | Audit log export, retention controls, SIEM streaming |
| Basic metrics | Analytics dashboards (throughput, merge rate, cost per PR) |
| Community support | Air-gap bundle, LTS releases, SLA support |

Pricing is per active repo or per seat, annual. A free tier covers small teams with no time limit.

## Phased roadmap

**Phase 0: Headless core (~3 weeks).** Build `packages/core` and the state machine ported from SKILL.md. The runner runs in Docker mode with the Agent SDK inside a job container. Add Postgres and the queue, and the CLI `fabrica run` against a local repo path that pushes a branch. *Exit criterion:* the two documented example jobs (reading time, 404 page) reproduce headless with the same verdict flow.

**Phase 1: GitHub + board (~4 weeks).** GitHub App via the manifest flow (github.com and GHES), webhook triggers (label and comment), PR creation, check runs per reviewer, `/fabrica rework` comments and merge detection. Add the web board with SSE and `docker-compose.yml`. Release as an **open-source alpha**.

**Phase 2: Models and policy (~3 weeks).** Provider config per role (Anthropic, Bedrock, Vertex, Foundry, gateway), the bundled LiteLLM profile, `fabrica eval`, `.fabrica/policy.yaml`, budgets and pluggable reviewers. Make the local skill read the same config.

**Phase 3: Production-ready (~4 weeks).** Helm chart with k8s runner mode, NetworkPolicies, secrets integration, OpenTelemetry and Prometheus, upgrade and migration tooling, `fabrica doctor`, docs site and **1.0 OSS release**.

**Phase 4: Enterprise (~4–6 weeks).** License key checks, SSO and SCIM, RBAC, audit log, policy packs, analytics and the air-gap bundle. Start design-partner pilots.

**Later:** GitLab and Bitbucket adapters behind a `GitProvider` interface (define it in Phase 1 even if only GitHub ships), Jira and Linear triggers, Slack notifications, and an optional managed control plane.

## Biggest risks

1. **Weaker models via the gateway** can degrade quality silently. Mitigate with `fabrica eval`, recommended model tiers per role, and defaulting security and approver to the strongest model configured.
2. **Self-host support burden.** Mitigate by keeping Postgres the only dependency, adding `fabrica doctor`, shipping images and charts that run with sensible defaults, and publishing upgrade docs.
3. **Sandbox escape or secret leakage** from agent-run code. Mitigate with no server credentials in containers, scoped short-lived tokens, egress allowlists and optional gVisor.
4. **Agent SDK licensing and terms** when embedded in a redistributed product. Confirm with Anthropic before the OSS release.

## Verification

- Golden tests: the state machine is unit-tested with fake agents that write fixed verdict files, covering all branches in SKILL.md (BLOCKED, exhausted rounds, ESCALATE, merge conflict, rework).
- End to end: a CI job runs `docker compose up` against a test GitHub org and fixture repo. A labelled issue must lead to a PR with 4 check runs, and both the rework and merge paths are exercised.
- Model matrix: run `fabrica eval` nightly against Claude on the Anthropic API and Bedrock plus one gateway model, and track pass rate and cost per job.
- Install tests: install fresh on a clean VM (Compose) and on kind (Helm) for every release.
