# Backlog

`/factory next` builds the first unchecked item and checks it off with its job id.

- [ ] Core job model in packages/core: types for job state matching job.json in SKILL.md (stages, round, reviews), parsers for the first-line contracts (VERDICT: PASS|CHANGES, APPROVE|ESCALATE, STATUS: READY|BLOCKED), and a loader that parses an agent .md file (frontmatter name/description/tools/model + prompt body) and a directory of them
- [ ] Orchestrator state machine in packages/core: a pure transition(state, event) → { state, actions } that ports every branch of .claude/skills/factory/SKILL.md (spec, build check, review rounds with WAIT FOR ALL, MAX_RESUMES, approve, merge outcomes, needs-human, /factory approve, /factory rework) including its agent prompts and per-job ports, unit-tested branch by branch
- [ ] Local runner in apps/runner: executes the state machine's actions on the host — git worktree create/merge/cleanup as SKILL.md does, agents via the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) using each agent file's prompt, tools and model, resuming the same builder session across rounds — and writes factory/jobs/<id>/job.json so factory/dashboard.html keeps working
- [ ] CLI in apps/cli: `fabrica run <feature>`, `fabrica next`, `fabrica approve <job-id>`, `fabrica rework <job-id> <note>` and `fabrica status`, matching the /factory commands in SKILL.md, driving apps/runner
- [ ] Model provider config: a fabrica.yaml mapping each agent role to a provider (Anthropic API, Bedrock, Vertex, Anthropic-compatible gateway base URL) and model, as in docs/ROADMAP.md, applied by the runner per agent call
