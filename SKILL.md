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
- Run `/jak install`, `/jak doctor`, `/jak uninstall` (slash commands wired in by Plan 4).

Do NOT invoke for:

- Plain `coordinator-pipeline` install — that skill is the prerequisite, this is the layer above it.
- Single-PR Mergify config — this skill installs the full pipeline, not piecemeal queue rules.

## High-level install flow

`scripts/install.sh` (currently a scaffold; populated by Plans 1-4) runs in this order from inside a target project's root:

1. **Pre-flight** — verify `coordinator-pipeline` is installed, GitHub branch protection on `main` is active, `gh`/`jq`/`uuidgen`/`flock` are present, and the Mergify GitHub App is installed on the org.
2. **MCP server** — copy `mcp/mergify/` into `<target>/.claude/mcp/`, create the `.env` skeleton, register the server with Claude Code, install the redaction wrapper.
3. **Mergify config** — copy `templates/.mergify.yml.tmpl` into `<target>/.mergify.yml`, customise queue conditions to the project's CI checks, install pr-reviewer agent overlay that applies `queue:*` labels.
4. **Jira integration** — provision the board (idempotent), install transition helper, register drift reconciliation pass with `tick.sh`, install retry queue.
5. **UAT scaffolding** — install chosen UAT strategy (default `local-docker`), add Storybook preview workflow (default Cloudflare Pages).
6. **Phased activation** — emit per-queue enable commits as a recipe in the install report; the user runs them on their own cadence (Day 0 disabled / Day 1-2 plan / Day 3-5 infra / Day 6-13 feature+bug+design / Day 14+ retire auto-update-prs.yml).

`scripts/doctor.sh` runs a non-destructive health check; `scripts/uninstall.sh` reverses the install.

## Prerequisites

Required in the downstream project:

- [`coordinator-pipeline`](../coordinator-pipeline/SKILL.md) **must already be installed.** This skill assumes its agents (planner / plan-reviewer / dev-agent / pr-reviewer), `agents/` journal directory, `scripts/coordinator/`, and `/coordinator-tick` slash command exist.
- GitHub branch protection on `main` (forces PR flow; required for the queue to mean anything).
- Mergify GitHub App installed on the org with API access.
- A Jira project + API token with permission to read/write transitions on the chosen project.
- For UAT: depends on chosen strategy. `local-docker` needs Docker on the dev machine or NAS; `vercel-preview` needs a Vercel team; `fly-staging` needs a Fly account.
- For Storybook previews: depends on chosen host. `cloudflare-pages` (default) needs a Cloudflare account with Pages enabled.

Required CLIs on the install machine: `gh`, `jq`, `uuidgen`, `flock`, `node` ≥ 20, `docker` (only for `local-docker` UAT).

## Status

**Plans 0–4 delivered.** `scripts/install.sh` runs end-to-end against a target project; `scripts/doctor.sh` validates the install. First-time installs and idempotent re-runs both exit 0.

| Plan       | Scope                                                                                                                         | Status                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Plan 0** | Skill scaffold — directory tree, SKILL.md, architecture reference, kanban-states reference, scripts skeletons.                | **delivered**           |
| **Plan 1** | Mergify MCP server (TS/stdio, 6 role-gated tools, redaction wrapper, failing-test fixture, pre-commit token-prefix hook).     | **delivered** (PR #1)   |
| **Plan 2** | `.mergify.yml.tmpl` + named-queue config; agent label-application transitions; `_label-log.jsonl` writer; phased activation.  | **delivered** (PR #2)   |
| **Plan 3** | Jira board provisioning, idempotent transition helper, `tick.sh` drift reconciliation, `_jira-retry.json` queue.              | **delivered** (PR #3)   |
| **Plan 4** | UAT environment Docker stack, pluggable strategy abstraction, Storybook preview-per-PR. (First install on TnT Finance pending.) | **delivered** (PR #5 — recovered after PR #4 was merged into the wrong base) |

Open follow-ups (not Plan-numbered):

- `install.sh`'s Plan 1 step is still a TODO — the MCP server isn't copied into a target's `.claude/mcp/` automatically. The server itself is fully built and tested under `mcp/mergify/`; only the install-side wiring is missing.
- No CI workflow on this repo. Plans 1–3 merged without ever running their own test suite, which is how 4 install-script tests went red on main undetected until 2026-05-13. Adding GitHub Actions to run `npm test` on PR is the next obvious gap.
- Plan 4's "first install on TnT Finance" deliverable is still outstanding — the scripts and templates are shipped, but no downstream has been bootstrapped yet.

## References

Three reference documents live alongside this SKILL.md and are the authoritative architecture statement for Plans 1-4 to build against:

- [`references/architecture.md`](references/architecture.md) — full master spec curated as decided architecture: 5 named queues, 6 MCP tools, branch-ticket binding regex, GitHub-canonical reconciliation, Jira idempotency contract, UAT strategies, Storybook hosting options, phased activation plan, Owner deliverables.
- [`references/kanban-states.md`](references/kanban-states.md) — 12-state machine with every forward and backward transition, Blocked sidebar swimlane semantics, Cancelled terminality, re-entry-via-new-ticket rule for Done. Includes a Mermaid `stateDiagram-v2` block.
- [`references/recovery-runbooks.md`](references/recovery-runbooks.md) — placeholder section headers for the 5 incident runbooks (Mergify queue stuck, Jira drift, MCP credential rotation, UAT rollback, phased rollout rollback). Each header is annotated with the downstream plan that fills its body.

## Upstream

Source of truth: <https://github.com/thomasbillings/jak-pipeline>. Discovered by Claude Code via the symlink at `~/.claude/skills/jak-pipeline -> /Users/tombone/code/jak-pipeline`.
