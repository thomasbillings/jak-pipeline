# jak uninstall

Remove the jak-pipeline skill from the current project.

You are running the `/jak uninstall` command. Invoke `scripts/uninstall.sh` from the jak-pipeline skill root with `DOWNSTREAM_ROOT` set to the current project. The script is idempotent — running it twice is safe and the second run is a no-op.

## 1. What gets removed

Everything `install.sh` created:

- `.claude/mcp/mergify/` (whole directory, including built dist and the `.env` credentials file)
- The `mergify` entry in `.mcp.json` (other entries preserved; file removed if no servers remain)
- `.mergify.yml`
- The pr-reviewer label-gate overlay block in `.claude/agents/pr-reviewer.md` (sentinel-bounded — pre-existing content preserved)
- `.claude/jak-pipeline/scripts/{label-gate-decide,label-log-append,branch-ticket-check}.sh`
- `.git/hooks/pre-commit` and `.git/hooks/pre-push` sentinel blocks (other hooks preserved)
- `scripts/jak-pipeline/jira/*` + `scripts/jak-pipeline/uat/*` + `scripts/jak-pipeline/doctor.sh`
- The `jak_pipeline_jira_tick_pass` block in `scripts/scrum-master/tick.sh`
- `.claude/jira/.env` (credentials — removing it is intentional)
- `.claude/jak-pipeline/config.env`
- `docker/docker-compose.local-uat.yml`
- `.github/workflows/storybook-preview.yml`
- The `agents/_label-log.jsonl` line in `.gitignore` (other entries preserved)

## 2. What's PRESERVED

The `agents/` directory is user-generated audit data and is never touched:
- `agents/_label-log.jsonl` (label-trust audit)
- `agents/_jira-retry.json` (Jira retry queue)
- Anything else the user has put under `agents/`

Pre-existing file content is preserved wherever the install used sentinel-bounded inserts: `pr-reviewer.md`, `tick.sh`, `.gitignore`, `.git/hooks/*`.

## 3. Run uninstall.sh

```bash
JAK_SKILL_ROOT="${JAK_SKILL_ROOT:-$HOME/.claude/skills/jak-pipeline}" \
DOWNSTREAM_ROOT="$PWD" \
bash "$JAK_SKILL_ROOT/scripts/uninstall.sh"
```

## 4. Dry run

To see what would be removed without actually deleting anything:

```bash
JAK_UNINSTALL_DRY_RUN=1 \
DOWNSTREAM_ROOT="$PWD" \
bash "$JAK_SKILL_ROOT/scripts/uninstall.sh"
```

Every action is prefixed with `[dry-run] would …`. Re-run without `JAK_UNINSTALL_DRY_RUN` to actually perform the removal.

## 5. After uninstall

The user must decide separately whether to archive the preserved `agents/` data. To re-install: run `/jak install` again from this directory.
