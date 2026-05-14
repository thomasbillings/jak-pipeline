# templates/

Project-specific config templates copied into the downstream repo by `scripts/install.sh`. Status reflects current `main` — Plans 2, 3, and 4 are delivered.

## Plan 2 — Mergify config + label trust boundary

- **`.mergify.yml.tmpl`** — full Mergify config with the 5 named queues (`bug`, `plan`, `feature`, `infra`, `design`), priorities, branch globs, `update_method: rebase`, `batch_size: 1`. Day-0 state: every queue `disabled: true`. Install path: `<downstream>/.mergify.yml`. See `references/architecture.md` §5.
- **`agents/pr-reviewer.md`** — full pr-reviewer agent file (shipped wholesale by PR-K, replacing the historical overlay-append model). Encodes the canonical `**Blockers (N)**` / `**Should-fix (M)**` / `**Nits (K)**` review format, the branch → queue label map, and the `queue:*` label-application gate (BLOCKERs=0 + CI green + own review APPROVED). Install path: `<downstream>/.claude/agents/pr-reviewer.md` (copy-if-missing — pre-existing user files preserved).
- **`phase-rollout-commits.md`** — per-queue activation cookbook. Each phase is a unified diff against the Day-0 `.mergify.yml`. Day 6–13 enable order: `queue:bug` → `queue:feature` → `queue:design`. Rationale in `references/architecture.md` §11.

## Plan 3 — Jira integration

- **`jira/.env.example`** — template for `<downstream>/.claude/jira/.env`. Documents the four required keys (`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT`). `scripts/install.sh` copies on first install and never overwrites an existing `.env`.

## Plan 4 — UAT + Storybook preview

- **`uat/local-docker/docker-compose.uat.yml`** — Docker Compose overlay for the `local-docker` UAT strategy. Env-parameterised (default ports: app 9670, postgres 5436) to avoid collisions with the downstream's dev stack. Named volume `jak_pipeline_local_uat_pgdata` scoped to the UAT stack — a `down --volumes` only nukes UAT data. Install path: `<downstream>/docker/docker-compose.local-uat.yml` (distinct from any pre-existing production `docker-compose.uat.yml`).
- **`github-actions/storybook-preview.yml`** — Per-PR Storybook deploy to Cloudflare Pages. Draft-skip rule (only runs when `pull_request.draft == false`), `--only-changed` build for ~30–40s incremental rebuilds. `package_manager` env var supports `npm`/`pnpm`/`yarn` (not `bun` — `actions/setup-node` cache doesn't support it). Install path: `<downstream>/.github/workflows/storybook-preview.yml`. Requires `CF_API_TOKEN` GitHub Actions secret (instruction emitted by `install.sh`; never written to disk).

## Other (skill-wide)

- **`gitignore-additions.txt`** — unified template appended to the downstream's `.gitignore` by Plan 0. Combines the scrum-master-pipeline block (agent state, journals, worktrees, plan-cache) with the jak-pipeline-specific entries (`/agents/_label-log.jsonl`, `/agents/_jira-retry.json`, `/.claude/jak-pipeline/config.env`). Sentinel-bounded: re-runs don't duplicate; uninstall strips the whole block.
