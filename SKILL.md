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

`scripts/install.sh` runs from inside a target project's root. Currently implemented steps are marked **(live)**; planned steps are marked **(planned)**:

1. **Pre-flight (planned)** — will verify `coordinator-pipeline` is installed, GitHub branch protection on `main` is active, `gh`/`python3`/`flock` are present, and the Mergify GitHub App is installed on the org.
2. **MCP server (planned)** — will copy `mcp/mergify/` build artefacts into `<target>/.claude/mcp/mergify/`, create the `.env` skeleton, install the redaction wrapper and pre-commit hook. Today the MCP server is fully built and tested in-repo at `mcp/mergify/`, but the install-side copy is a TODO.
3. **Mergify config (live)** — copies `templates/.mergify.yml.tmpl` to `<target>/.mergify.yml`, installs the pr-reviewer agent overlay that applies `queue:*` labels, installs the three label-trust helper scripts to `<target>/.claude/jak-pipeline/scripts/`, wires `branch-ticket-check.sh` into `.git/hooks/pre-push` (or `.husky/pre-push`).
4. **Jira integration (live)** — copies the transition helper, drift reconciliation pass, retry queue drain, and tick-extension into `<target>/scripts/jak-pipeline/jira/`; templates `<target>/.claude/jira/.env`; appends the `jak_pipeline_jira_tick_pass` source line to `scripts/coordinator/tick.sh`.
5. **UAT scaffolding (live, partial)** — prompts for UAT strategy (default `local-docker`); on `local-docker` copies the Compose overlay to `<target>/docker/docker-compose.local-uat.yml`; copies the Storybook preview workflow to `<target>/.github/workflows/`. The four UAT lifecycle scripts (`run.sh`, `local-docker-{start,stop,accept,reject}.sh`) are **not yet copied** into the downstream — this is the open Plan 4 install-side gap.
6. **Phased activation (live)** — emits the per-queue enable cookbook reference; the user applies phases from `templates/phase-rollout-commits.md` on their own cadence (Day 0 disabled / Day 1-2 plan / Day 3-5 infra / Day 6-13 bug→feature→design / Day 14+ retire auto-update-prs.yml).

`scripts/doctor.sh` runs a non-destructive health check (Plan 2 + Plan 3 + Plan 4 sections live; Plan 1 section depends on the planned MCP install wiring). `scripts/uninstall.sh` is currently a scaffold that exits non-zero; full reversal is planned.

## Prerequisites

Required in the downstream project:

- [`coordinator-pipeline`](../coordinator-pipeline/SKILL.md) **must already be installed.** This skill assumes its agents (planner / plan-reviewer / dev-agent / pr-reviewer), `agents/` journal directory, `scripts/coordinator/`, and `/coordinator-tick` slash command exist.
- GitHub branch protection on `main` (forces PR flow; required for the queue to mean anything).
- Mergify GitHub App installed on the org with API access.
- A Jira project + API token with permission to read/write transitions on the chosen project.
- For UAT: depends on chosen strategy. `local-docker` needs Docker on the dev machine or NAS; `vercel-preview` needs a Vercel team; `fly-staging` needs a Fly account.
- For Storybook previews: depends on chosen host. `cloudflare-pages` (default) needs a Cloudflare account with Pages enabled.

Required CLIs on the install machine: `gh`, `python3`, `flock`, `node` ≥ 20, `bash` ≥ 4, `bc` (used by Jira retry-backoff timer), `docker` (only for `local-docker` UAT). PyYAML (`pip install pyyaml` or system `python3-yaml`) is needed by `doctor.sh`'s Plan 2 YAML parse check; the check will report "does not parse" if PyYAML is missing.

## Status

**Plans 0–4 delivered.** `scripts/install.sh` runs end-to-end against a target project; `scripts/doctor.sh` validates the install. First-time installs and idempotent re-runs both exit 0.

| Plan       | Scope                                                                                                                         | Status                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Plan 0** | Skill scaffold — directory tree, SKILL.md, architecture reference, kanban-states reference, scripts skeletons.                | **delivered**           |
| **Plan 1** | Mergify MCP server (TS/stdio, 6 role-gated tools, redaction wrapper, failing-test fixture, pre-commit token-prefix hook).     | **delivered** (PR #1)   |
| **Plan 2** | `.mergify.yml.tmpl` + named-queue config; agent label-application transitions; `_label-log.jsonl` writer; phased activation.  | **delivered** (PR #2)   |
| **Plan 3** | Jira board provisioning, idempotent transition helper, `tick.sh` drift reconciliation, `_jira-retry.json` queue.              | **delivered** (PR #3)   |
| **Plan 4** | UAT environment Docker stack, pluggable strategy abstraction, Storybook preview-per-PR. (First install on TnT Finance pending.) | **delivered** (PR #5 — recovered after PR #4 was merged into the wrong base) |

Open follow-ups (not Plan-numbered). Each links to its scheduled PR-slug:

- **PR-B (Plan 1 install wiring)** — `install.sh`'s Plan 1 step is still a TODO. The MCP server is fully built and tested under `mcp/mergify/`, but `install.sh` never copies it to `<downstream>/.claude/mcp/mergify/` or templates the `.env` or installs the pre-commit hook. `doctor.sh`'s Plan 1 section also needs its MCP path resolver fixed for the downstream layout.
- **PR-C (Plan 4 install wiring)** — `install.sh`'s Plan 4 section copies the Compose overlay and Storybook workflow but skips the four UAT lifecycle scripts (`scripts/uat/run.sh` + the four `local-docker-*.sh`). Runbook §4 references those installed paths; they don't exist post-install today.
- **PR-D (pre-flight checks)** — install.sh §1 step 1 above is aspirational. No CLI / coordinator-pipeline / branch-protection / GitHub-App checks today.
- **PR-E (label-log-append.sh `N/A` crash)** — architecture §7 specifies `blocker_count=N/A` for user-applied labels but the writer crashes on non-numeric values.
- **PR-G (uninstall.sh)** — scaffold-only; reversal is planned.
- **PR-H (token-prefix expansion)** — pre-commit hook + redaction wrapper miss newer GitHub formats (`gho_`, `ghu_`, `ghe_`).
- ~~**PR-I (slash commands)** — `/jak install`, `/jak doctor`, `/jak uninstall` referenced by the original Plan 4 brief don't exist yet.~~ Delivered: see [.claude/commands/](.claude/commands/).
- **Plan 4 first downstream install (post-PR-C)** — still pending. The "first install on TnT Finance" deliverable depends on PR-B+PR-C.
- **CI workflow (PR-F)** — landing automated test runs on PR makes the rest of these safer to ship.
- **`main` is not branch-protected.** That's how PR #4 was merged into a non-main base in the first place. Set up branch protection once the audit follow-ups are merged.

## References

Three reference documents live alongside this SKILL.md and are the authoritative architecture statement that the implementation builds against:

- [`references/architecture.md`](references/architecture.md) — full master spec: 5 named queues, 6 MCP tools, branch-ticket binding regex, GitHub-canonical reconciliation, Jira idempotency contract, UAT strategies, Storybook hosting options, phased activation plan, Owner deliverables.
- [`references/kanban-states.md`](references/kanban-states.md) — 12-state machine with every forward and backward transition, Blocked sidebar swimlane semantics, Cancelled terminality, re-entry-via-new-ticket rule for Done. Includes a Mermaid `stateDiagram-v2` block.
- [`references/recovery-runbooks.md`](references/recovery-runbooks.md) — 5 incident runbooks (Mergify queue stuck, Jira drift, MCP credential rotation, UAT rollback, phased rollout rollback). All sections populated; per-section "Owned by" line indicates which plan ships the listed primitives.

## Upstream

Source of truth: <https://github.com/thomasbillings/jak-pipeline>. Discovered by Claude Code via the symlink at `~/.claude/skills/jak-pipeline` (the link target is host-specific — typically `~/.claude/skills/jak-pipeline → <user>/code/jak-pipeline` on macOS or `/home/<user>/workspace/jak-pipeline` on Linux dev containers).
