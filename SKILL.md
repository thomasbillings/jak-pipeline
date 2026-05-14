---
name: jak-pipeline
description: >
  Reusable Claude Code skill that bootstraps a Jira + Agent + Kanban delivery
  pipeline onto any project. Installs a Mergify-driven merge queue with named
  lanes (bug / plan / feature / infra / design), a 12-state kanban board
  reconciled from GitHub PR state, an idempotent Jira integration, a
  role-gated Mergify MCP server, a phased per-queue activation plan, and a
  pluggable UAT gate (default local-docker, optional vercel-preview /
  fly-staging / none) plus Storybook preview-per-PR (default Cloudflare Pages).
  Trigger: "set up jak-pipeline", "install jak-pipeline", "bootstrap kanban
  pipeline", "wire up Mergify queue", "/jak install".
---

# jak-pipeline

A reusable Claude Code skill that turns a single-developer-with-agents repo into a small-team-grade delivery pipeline: Jira board on the left, Mergify merge queue in the middle, a kanban-truth view across the top. Built to layer on top of [`coordinator-pipeline`](../coordinator-pipeline/SKILL.md) — `coordinator-pipeline` provides plans, agents, and dispatch; `jak-pipeline` adds the queue/board/UAT scaffolding.

## What it does

Installs a 12-state kanban (`Idea → Backlog → Planning → Plan Review → Ready to Dev → In Development → PR Review → Merge Queue → UAT → Done`, plus `Blocked` swimlane and `Cancelled` terminal) where every transition is driven by GitHub PR state, projected onto Mergify's queue and Jira's board. Five named queues (`bug`, `plan`, `feature`, `infra`, `design`) each carry a priority, a branch glob, and a CI gate. A role-gated Mergify MCP server lets agents inspect the queue without shell access; only the coordinator can mutate it. UAT is a pluggable gate (local-docker / vercel-preview / fly-staging / none) and Storybook gets a per-PR preview (Cloudflare Pages default). A phased rollout activates one queue at a time over ~14 days; the legacy `auto-update-prs.yml` workflow is retired only after two green weeks.

## Trigger conditions

Invoke when the user asks to:

- "set up jak-pipeline" / "install jak-pipeline" / "bootstrap kanban pipeline".
- "wire up the Mergify queue" / "add named queues" / "phased rollout for Mergify".
- "add UAT before main" / "add Storybook previews per PR" on a project that already has `coordinator-pipeline` installed.
- Run `/jak install`, `/jak doctor`, or `/jak uninstall` (slash commands at [.claude/commands/](.claude/commands/) delegating to the matching script in `scripts/`).

Do NOT invoke for:

- Plain `coordinator-pipeline` install — that skill is the prerequisite, this is the layer above it.
- Single-PR Mergify config — this skill installs the full pipeline, not piecemeal queue rules.

## High-level install flow

`scripts/install.sh` runs from inside a target project's root. All seven steps are live:

1. **Pre-flight** — verifies the downstream is a git repository and the required CLIs (`gh`, `python3`, `flock`, `node` ≥ 20, `bash` ≥ 4) are available. With `JAK_REMOTE_CHECKS=1`, also verifies GitHub branch protection on `main` and Mergify GitHub App install. Bypass with `JAK_SKIP_PREFLIGHT=1`.
2. **Plan 0 — Coordinator pipeline scaffolding.** Absorbed from the formerly separate `coordinator-pipeline` skill. Creates `plans/`, `agents/`, `agents/archive/`, `.claude/agents/`, `.claude/commands/`, `scripts/coordinator/`. Installs the planner / plan-reviewer / dev-agent / coordinator-tick template files (never overwrites). Installs `tick.sh`, `dispatch.sh`, `lib.sh`, `check-plan.sh`. Appends the unified gitignore template (coordinator + jak-pipeline entries). Plan-repo mode prompt — non-interactive via `JAK_PLAN_REPO=<owner>/<repo>` + optional `JAK_PROJECT_NAME=<name>`.
3. **Plan 1 — Mergify MCP server.** Copies `mcp/mergify/{dist,src,package.json,package-lock.json,tsconfig.json,README.md}` to `<target>/.claude/mcp/mergify/`, runs `npm ci --omit=dev`, templates `.env` (idempotent), writes a `run.sh` wrapper, registers the server in `<target>/.mcp.json` (preserves other entries), installs the token-prefix-scan pre-commit hook.
4. **Plan 2 — Mergify config + label trust.** Copies `templates/.mergify.yml.tmpl` to `<target>/.mergify.yml`, appends the pr-reviewer agent overlay that applies `queue:*` labels (sentinel-bounded, idempotent), installs the three label-trust helper scripts to `<target>/.claude/jak-pipeline/scripts/`, wires `branch-ticket-check.sh` into `.git/hooks/pre-push` (or `.husky/pre-push`).
5. **Plan 3 — Jira integration.** Copies the transition helper, drift reconciliation pass, retry queue drain, and tick-extension into `<target>/scripts/jak-pipeline/jira/`; templates `<target>/.claude/jira/.env`; appends the `jak_pipeline_jira_tick_pass` source line to `scripts/coordinator/tick.sh`.
6. **Plan 4 — UAT + Storybook.** Prompts for UAT strategy (default `local-docker`); on `local-docker` copies the Compose overlay to `<target>/docker/docker-compose.local-uat.yml`; copies the Storybook preview workflow to `<target>/.github/workflows/`; copies the four UAT lifecycle scripts + `run.sh` dispatcher into `<target>/scripts/jak-pipeline/uat/`.
7. **Phased activation.** Emits the per-queue enable cookbook reference; the user applies phases from `templates/phase-rollout-commits.md` on their own cadence (Day 0 disabled / Day 1-2 plan / Day 3-5 infra / Day 6-13 bug→feature→design / Day 14+ retire auto-update-prs.yml).

`scripts/doctor.sh` runs a non-destructive health check covering Plans 1–4. `scripts/uninstall.sh` reverses the install: removes every file install.sh created (including credentials in `.env` files and the Plan 0 coordinator scaffolding); preserves `agents/` (user-generated audit data) and `plans/<your-plans>.md` (user-written plans), and strips sentinel-bounded blocks from `pr-reviewer.md`, `tick.sh`, `.gitignore`, and git hooks. Run via the `/jak install`, `/jak doctor`, `/jak uninstall` slash commands or invoke the scripts directly.

## Prerequisites

Required in the downstream project:

- GitHub branch protection on `main` (forces PR flow; required for the queue to mean anything).
- Mergify GitHub App installed on the org with API access.
- A Jira project + API token with permission to read/write transitions on the chosen project.
- For UAT: depends on chosen strategy. `local-docker` needs Docker on the dev machine or NAS; `vercel-preview` needs a Vercel team; `fly-staging` needs a Fly account.
- For Storybook previews: depends on chosen host. `cloudflare-pages` (default) needs a Cloudflare account with Pages enabled.

Required CLIs on the install machine: `gh`, `python3`, `flock`, `node` ≥ 20, `bash` ≥ 4, `bc` (used by Jira retry-backoff timer), `docker` (only for `local-docker` UAT). PyYAML (`pip install pyyaml` or system `python3-yaml`) is needed by `doctor.sh`'s Plan 2 YAML parse check; the check will report "does not parse" if PyYAML is missing.

## Status

**Plans 0–4 delivered + coordinator-pipeline absorbed.** `scripts/install.sh` runs end-to-end against a target project; `scripts/doctor.sh` validates the install. First-time installs and idempotent re-runs both exit 0.

| Plan       | Scope                                                                                                                         | Status                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Plan 0** | Coordinator-pipeline scaffolding — planner / plan-reviewer / dev-agent / coordinator-tick + tick.sh / dispatch.sh / lib.sh / check-plan.sh + gitignore template. Absorbed from the formerly-separate `coordinator-pipeline` skill. | **delivered** (PR-J) |
| **Plan 1** | Mergify MCP server (TS/stdio, 6 role-gated tools, redaction wrapper, failing-test fixture, pre-commit token-prefix hook).     | **delivered** (PR #1)   |
| **Plan 2** | `.mergify.yml.tmpl` + named-queue config; agent label-application transitions; `_label-log.jsonl` writer; phased activation.  | **delivered** (PR #2)   |
| **Plan 3** | Jira workflow provisioning (12 statuses + scheme via `/rest/api/3/workflows/create`; board column mapping is a manual UI step on Cloud), idempotent transition helper, `tick.sh` drift reconciliation, `_jira-retry.json` queue. | **delivered** (PR #3; `provision-board.sh` rewrite for the workflows API in issue #23) |
| **Plan 4** | UAT environment Docker stack, pluggable strategy abstraction, Storybook preview-per-PR. (First install on TnT Finance pending.) | **delivered** (PR #5 — recovered after PR #4 was merged into the wrong base) |

Open follow-ups:

- **First downstream install pending.** The installer is end-to-end functional but no downstream has been bootstrapped yet. The "first install on TnT Finance" deliverable from Plan 4 is the next concrete step.
- **`agents/_cost-report.md` (architecture §12 deliverable)** — Mergify queue actions + Anthropic spend per merged PR. Flagged at Plan 4 but never assigned a plan.
- **Failure-escalation transport (architecture §12 deliverable)** — silent handoffs >10 min fire a notification (ntfy vs Slack vs both). Needs a new plan.

Branch protection on `main` is configured (2026-05-14): required status checks (`top-level vitest`, `mcp/mergify vitest + build`) must pass with strict (up-to-date branch) enforcement; `enforce_admins: true`; force pushes and deletion disallowed; PR conversation resolution required. No human-approval requirement set (solo maintainer + Claude workflow would block self-merges).

A full audit on 2026-05-13 surfaced 9 install-side gaps (Plan 1 install wiring, Plan 4 install wiring, pre-flight checks, label-log N/A crash, token-prefix gaps, scaffold-only uninstall, missing slash commands, no CI workflow, PR #6 runbook bugs). All 9 closed via PRs #7–#16 (2026-05-13/14). Coordinator-pipeline absorbed via PR-J and pr-reviewer agent shipped via PR-K (2026-05-14).

## References

Three reference documents live alongside this SKILL.md and are the authoritative architecture statement that the implementation builds against:

- [`references/architecture.md`](references/architecture.md) — full master spec: 5 named queues, 6 MCP tools, branch-ticket binding regex, GitHub-canonical reconciliation, Jira idempotency contract, UAT strategies, Storybook hosting options, phased activation plan, Owner deliverables.
- [`references/kanban-states.md`](references/kanban-states.md) — 12-state machine with every forward and backward transition, Blocked sidebar swimlane semantics, Cancelled terminality, re-entry-via-new-ticket rule for Done. Includes a Mermaid `stateDiagram-v2` block.
- [`references/recovery-runbooks.md`](references/recovery-runbooks.md) — 5 incident runbooks (Mergify queue stuck, Jira drift, MCP credential rotation, UAT rollback, phased rollout rollback). All sections populated; per-section "Owned by" line indicates which plan ships the listed primitives.

## Upstream

Source of truth: <https://github.com/thomasbillings/jak-pipeline>. Discovered by Claude Code via the symlink at `~/.claude/skills/jak-pipeline` (the link target is host-specific — typically `~/.claude/skills/jak-pipeline → <user>/code/jak-pipeline` on macOS or `/home/<user>/workspace/jak-pipeline` on Linux dev containers).
