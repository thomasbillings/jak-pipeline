# jak doctor

Validate a jak-pipeline install in the current project.

You are running the `/jak doctor` command. Invoke `scripts/jak-pipeline/doctor.sh` (the installed copy of `doctor.sh`) with `DOWNSTREAM_ROOT` set to the current project. Doctor runs non-destructive checks against Plans 1–4 and reports failures with remediation hints.

## 1. Run doctor.sh

```bash
DOWNSTREAM_ROOT="$PWD" bash scripts/jak-pipeline/doctor.sh
```

If the installed copy is missing (jak-pipeline never installed, or partially uninstalled), fall back to the skill repo's copy:

```bash
JAK_SKILL_ROOT="${JAK_SKILL_ROOT:-$HOME/.claude/skills/jak-pipeline}" \
DOWNSTREAM_ROOT="$PWD" \
bash "$JAK_SKILL_ROOT/scripts/doctor.sh"
```

## 2. What it checks

Per plan (each section is independent):

- **Plan 1 (MCP server)** — `.claude/mcp/mergify/{dist/server.js,run.sh,.env}` exists; `.mcp.json` registers the `mergify` server; redaction wrapper importable + functional with a synthetic `mrg_live_` token.
- **Plan 2 (Mergify config + label trust)** — `.mergify.yml` parses as valid YAML (requires PyYAML installed); pr-reviewer overlay sentinel present; `agents/` writable; three label-trust scripts executable.
- **Plan 3 (Jira)** — `.claude/jira/.env` has all 4 keys; Jira credentials authenticate against `/rest/api/3/myself`; `agents/_jira-retry.json` has no items older than 24h; `tick.sh` registers `jak_pipeline_jira_tick_pass`.
- **Plan 4 (UAT + Storybook)** — `.claude/jak-pipeline/config.env` has `JAK_UAT_STRATEGY` and `CF_PAGES_PROJECT`; Docker overlay parses if strategy is `local-docker`; Storybook workflow exists and references `CF_PAGES_PROJECT`; `CF_API_TOKEN` is set as a GitHub Actions secret; all 5 UAT lifecycle scripts present and executable.

## 3. Plan-scoped runs

Doctor supports running individual plan sections in isolation. Use these when triaging a specific incident:

- `PLAN3_CHECK=1` — skip Plan 1 and report Plan 3 only.
- `PLAN4_CHECK=1` — skip Plan 1 and report Plan 4 only.

Example: `PLAN3_CHECK=1 DOWNSTREAM_ROOT=$PWD bash scripts/jak-pipeline/doctor.sh`

## 4. Exit codes

- `0` — all checks for the in-scope plans passed.
- `1` — at least one check failed. The script prints all failures with paths; rerun `/jak install` if it's an "installer didn't run" issue, or fix configuration if it's a credentials issue.
