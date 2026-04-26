# templates/

Project-specific config templates copied into the downstream repo by `scripts/install.sh`.

**Currently empty.** Populated by **Plan 2** (Mergify config + agent label transitions). Expected contents after Plan 2 lands:

- `.mergify.yml.tmpl` — the full Mergify config with the 5 named queues (`bug`, `plan`, `feature`, `infra`, `design`), priorities, branch globs, CI gates, and `update_method: rebase` + `Sequential, batch_size:1` settings (see `references/architecture.md` §5).
- `agents/pr-reviewer.tmpl.md` — the agent-file overlay that adds the `queue:*` label-application gate (BLOCKERs=0 + tests-green).
- `_label-log.jsonl.template` — header / schema doc for the audit log writer.
- `gitignore-additions.txt` — entries the install script appends to the downstream repo's `.gitignore` (e.g. the MCP `.env` file path).
- Phase-rollout commit cookbook — the per-queue enable commits documented in `references/architecture.md` §10.
