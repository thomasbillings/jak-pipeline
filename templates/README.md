# templates/

Project-specific config templates copied into the downstream repo by `scripts/install.sh`.

## Plan 2 templates (Mergify config + agent label transitions)

Expected after Plan 2 lands:

- `.mergify.yml.tmpl` — the full Mergify config with the 5 named queues (`bug`, `plan`, `feature`, `infra`, `design`), priorities, branch globs, CI gates, and `update_method: rebase` + `Sequential, batch_size:1` settings (see `references/architecture.md` §5).
- `agents/pr-reviewer.tmpl.md` — the agent-file overlay that adds the `queue:*` label-application gate (BLOCKERs=0 + tests-green).
- `_label-log.jsonl.template` — header / schema doc for the audit log writer.
- `gitignore-additions.txt` — entries the install script appends to the downstream repo's `.gitignore` (e.g. the MCP `.env` file path).
- Phase-rollout commit cookbook — the per-queue enable commits documented in `references/architecture.md` §10.

## Plan 3 templates (Jira integration)

- `jira/.env.example` — template skeleton for `<downstream>/.claude/jira/.env`. Documents all four Jira env vars (`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT`) with one-line comments. `scripts/install.sh` copies this to the downstream project on first install; never overwrites an existing `.env`.
