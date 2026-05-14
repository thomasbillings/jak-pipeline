# jak-pipeline

A reusable [Claude Code skill](https://claude.com/claude-code) that wires a Jira board + Agent overlay + named Mergify merge queues onto any project that already has `coordinator-pipeline` installed. Layers on top of `coordinator-pipeline` — plans/agents come from there; queue, board, and UAT scaffolding come from here.

> **Primary documentation lives in [`SKILL.md`](SKILL.md).** This README is the GitHub-landing-page summary; read SKILL.md for the full skill contract, install flow, and current status.

## What it installs

- **Mergify MCP server** — TypeScript stdio server exposing 6 role-gated queue-inspection tools (`mergify_get_queue_summary`, `mergify_check_pr_eligibility`, etc.) to Claude agents. Redaction wrapper strips 9 token prefixes from every error envelope; env-leak guard refuses to start if credentials are inside the repo. Installed at `<downstream>/.claude/mcp/mergify/` and registered in `.mcp.json` automatically.
- **Mergify config** — `.mergify.yml.tmpl` with 5 named queues (`bug`, `plan`, `feature`, `infra`, `design`), priorities, branch globs, and CI gates. Day 0 ships with every queue `disabled: true`; phased activation cookbook in `templates/phase-rollout-commits.md`.
- **Label trust boundary** — `scripts/label-gate-decide.sh` enforces that only the `pr-reviewer` agent may apply `queue:*` labels, and only after BLOCKERs=0 + tests-green. Every decision is appended to `agents/_label-log.jsonl`.
- **Jira integration** — idempotent transition helper (`scripts/jira/transition.sh`), drift reconciliation pass that hooks into `tick.sh`, retry queue at `agents/_jira-retry.json`. Jira outages never block a Mergify merge.
- **UAT gate** — pluggable strategy (`local-docker` / `vercel-preview` / `fly-staging` / `none`); installs the Compose overlay, the 5 lifecycle scripts (`run.sh` + four `local-docker-*.sh`), and the Storybook preview workflow into the downstream.
- **Slash commands** — `/jak install`, `/jak doctor`, `/jak uninstall` delegate to the corresponding scripts.

> **State of the install:** Plans 0–4 are merged and the installer is end-to-end functional. The first downstream bootstrap (the original "first install on TnT Finance" deliverable) is the only remaining concrete work. See [`SKILL.md` Open follow-ups](SKILL.md#status) for the operational follow-ups (downstream install, branch protection on this repo's `main`).

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
| [`mcp/mergify/`](mcp/mergify/) | Mergify MCP server source + 87 unit tests |
| [`scripts/`](scripts/) | Install / doctor / lifecycle scripts (`install.sh`, `doctor.sh`, `jira/`, `uat/`) |
| [`templates/`](templates/) | Templates copied into the downstream by `install.sh` |
| [`tests/`](tests/) | Skill-side tests (201 vitest tests across 32 files) |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Branch naming, test requirements, PR conventions |
| [`SECURITY.md`](SECURITY.md) | Vulnerability disclosure policy |
| [`LICENSE`](LICENSE) | MIT |

## Tests

```bash
npm ci                          # top-level dev deps
npx vitest run                  # 201 tests, 32 files

cd mcp/mergify
npm ci                          # MCP server deps
npx vitest run                  # 87 tests, 9 files
npm run build                   # emits dist/server.js
```

## Status

Plans 0–4 are delivered + coordinator-pipeline absorbed + pr-reviewer agent shipped. See [`SKILL.md`](SKILL.md) for the status table and remaining operational follow-ups (first downstream install, the two §12 known-deferred items). The repo's security posture (LICENSE, SECURITY.md, branch protection, Dependabot, CodeQL, CODEOWNERS, pinned Actions, least-privilege workflow tokens) is documented in [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).
