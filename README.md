# jak-pipeline

A reusable [Claude Code skill](https://claude.com/claude-code) that wires a Jira board + Agent overlay + named Mergify merge queues onto any project that already has `coordinator-pipeline` installed. Layers on top of `coordinator-pipeline` — plans/agents come from there; queue, board, and UAT scaffolding come from here.

> **Primary documentation lives in [`SKILL.md`](SKILL.md).** This README is the GitHub-landing-page summary; read SKILL.md for the full skill contract, install flow, and current status.

## What it installs

- **Mergify MCP server** — TypeScript stdio server in `mcp/mergify/` exposing 6 role-gated queue-inspection tools (`mergify_get_queue_summary`, `mergify_check_pr_eligibility`, etc.) to Claude agents. Redaction wrapper strips token prefixes from every error envelope; env-leak guard refuses to start if credentials are inside the repo.
- **Mergify config** — `.mergify.yml.tmpl` with 5 named queues (`bug`, `plan`, `feature`, `infra`, `design`), priorities, branch globs, and CI gates. Day 0 ships with every queue `disabled: true`; phased activation cookbook in `templates/phase-rollout-commits.md`.
- **Label trust boundary** — `scripts/label-gate-decide.sh` enforces that only the `pr-reviewer` agent may apply `queue:*` labels, and only after BLOCKERs=0 + tests-green. Every decision is appended to `agents/_label-log.jsonl`.
- **Jira integration** — idempotent transition helper (`scripts/jira/transition.sh`), drift reconciliation pass that hooks into `tick.sh`, retry queue at `agents/_jira-retry.json`. Jira outages never block a Mergify merge.
- **UAT gate** — pluggable strategy (`local-docker` / `vercel-preview` / `fly-staging` / `none`); local-docker overlay at `templates/uat/local-docker/docker-compose.uat.yml`. Accept/reject lifecycle in `scripts/uat/`.
- **Storybook preview** — per-PR deploy to Cloudflare Pages via `templates/github-actions/storybook-preview.yml`; draft-skip rule and `--only-changed` build.

## Quick start

The skill installs itself into a downstream project that already has `coordinator-pipeline`. Run from the target project's root:

```bash
JAK_SKILL_ROOT=~/code/jak-pipeline bash $JAK_SKILL_ROOT/scripts/install.sh
```

The script is idempotent — second run reports `already present` for every step. Run the diagnostic counterpart any time:

```bash
DOWNSTREAM_ROOT=$(pwd) bash $JAK_SKILL_ROOT/scripts/doctor.sh
```

## Repository layout

| Path | Purpose |
| --- | --- |
| [`SKILL.md`](SKILL.md) | Skill contract, install flow, current plan status |
| [`references/architecture.md`](references/architecture.md) | Authoritative architecture: 5 queues, 6 MCP tools, branch-ticket regex, idempotency contract, UAT strategies |
| [`references/kanban-states.md`](references/kanban-states.md) | 12-state machine + Mermaid `stateDiagram-v2` |
| [`references/recovery-runbooks.md`](references/recovery-runbooks.md) | 5 incident runbooks (queue stuck, Jira drift, MCP creds, UAT rollback, phase rollback) |
| [`mcp/mergify/`](mcp/mergify/) | Mergify MCP server source + 81 unit tests |
| [`scripts/`](scripts/) | Install / doctor / lifecycle scripts (`install.sh`, `doctor.sh`, `jira/`, `uat/`) |
| [`templates/`](templates/) | Templates copied into the downstream by `install.sh` |
| [`tests/`](tests/) | Skill-side tests (136 vitest tests across 24 files) |

## Tests

```bash
npm ci                          # top-level dev deps
npx vitest run                  # 136 tests, 24 files

cd mcp/mergify
npm ci                          # MCP server deps
npx vitest run                  # 81 tests, 9 files
npm run build                   # emits dist/server.js
```

## Status

Plans 0–4 are delivered. See the SKILL.md status table for the per-plan PR links and the list of open follow-ups (notably: install-side Plan 1 wiring is a TODO, no CI workflow on this repo, first downstream install pending).
