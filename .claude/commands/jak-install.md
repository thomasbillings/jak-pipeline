# jak install

Install the jak-pipeline skill into the current project.

You are running the `/jak install` command. Invoke `scripts/install.sh` from the jak-pipeline skill root, with `DOWNSTREAM_ROOT` set to the current project directory.

## 1. Locate the skill

The jak-pipeline skill lives wherever the user installed it (typically `~/.claude/skills/jak-pipeline` symlinked to a checkout). If `JAK_SKILL_ROOT` is set in the environment, use that. Otherwise resolve it from the symlink target.

## 2. Run install.sh

```bash
JAK_SKILL_ROOT="${JAK_SKILL_ROOT:-$HOME/.claude/skills/jak-pipeline}" \
DOWNSTREAM_ROOT="$PWD" \
bash "$JAK_SKILL_ROOT/scripts/install.sh"
```

The script is interactive when run with a TTY — it will prompt for `JAK_UAT_STRATEGY` (default `local-docker`) and `CF_PAGES_PROJECT` (Cloudflare Pages project name for Storybook previews). To pass them non-interactively, set the env vars before running.

## 3. Common env switches

- `JAK_REMOTE_CHECKS=1` — additionally run remote pre-flight checks (branch protection on `main`, Mergify GitHub App install). Defaults off so the script doesn't make network calls without explicit opt-in.
- `JAK_SKIP_PREFLIGHT=1` — bypass the pre-flight checks (use only when you know the environment is OK; recovery installs).
- `JAK_PLAN1_SKIP_NPM=1` — skip the MCP server's `npm ci --omit=dev` step (test/CI only — production installs should never set this).

## 4. After install

Two follow-up actions the user must do manually:

1. **Fill in credentials.** Three env files were templated with empty values — populate them before the integration is functional:
   - `.claude/mcp/mergify/.env` (4 keys: `MERGIFY_API_KEY`, `MERGIFY_ORG`, `GITHUB_TOKEN`, `MERGIFY_MCP_ROLE`)
   - `.claude/jira/.env` (4 keys: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT`)
2. **Add the Cloudflare API token as a GitHub Actions secret.** `CF_API_TOKEN` belongs in repo → Settings → Secrets and variables → Actions. Never write it to disk.

Then run `/jak doctor` to verify everything.

## 5. Reference

- Skill contract: `$JAK_SKILL_ROOT/SKILL.md`
- Architecture: `$JAK_SKILL_ROOT/references/architecture.md`
- Recovery runbooks: `$JAK_SKILL_ROOT/references/recovery-runbooks.md`
