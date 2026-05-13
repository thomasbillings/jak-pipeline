# Recovery runbooks (jak-pipeline)

This file holds operational recovery procedures for the jak-pipeline. Every runbook is currently a placeholder header — bodies are populated by the downstream plan that owns the failure mode it covers.

> **Empty body ≠ "we forgot."** An empty section means the downstream plan listed under "Owned by" has not landed yet. When it lands, that plan's PR fills in the body of its assigned section in this file.

---

## 1. Mergify queue stuck

> **Owned by:** Plan 2 (Mergify config + agent label transitions).

### Symptoms

- A PR has a `queue:*` label and `Mergify` has acknowledged it, but no merge action fires.
- `mergify_get_queue_summary` returns the PR in `queued` state for ≥30 minutes with no progress.
- Mergify's PR-thread comments cycle "rebased", "rebased", "rebased" without a merge.
- The CI check named in `.mergify.yml` never reports back — queue rule condition can't be satisfied.
- A `queue:*` label was applied but Mergify ignores it (queue rule mismatched against branch glob).

### Diagnosis

The 6 Mergify MCP tools are stdio-registered, not shell CLIs — operators invoke them by asking Claude inside a coordinator-role session, not by running a shell command. The shell commands below cover the parts of diagnosis that don't go through MCP. The MCP-side prompts to use are shown alongside.

```bash
# 1. Compare the branch name against the queue's head glob
#    in .mergify.yml. Example: queue:feature requires head~=^feat/
grep -A 1 "name: feature" .mergify.yml | grep head

# 2. Compare the failing check names against the branch's actual checks
gh pr checks <PR>

# 3. Read the label-trust audit log for ordering anomalies
tail -20 agents/_label-log.jsonl | python3 -m json.tool
```

**MCP-side diagnosis (Claude session, coordinator role):**

Ensure `MERGIFY_MCP_ROLE=coordinator` is set in the MCP server's `.env`, then ask Claude:

> "Read the Mergify queue summary and tell me which queues have backlog. Then for PR &lt;N&gt;, run `mergify_get_queue_details` and `mergify_check_pr_eligibility` and report which `queue_conditions` are failing."

Claude invokes `mergify_get_queue_summary` (30s cache), `mergify_get_queue_details(pr=<N>)`, and `mergify_check_pr_eligibility(pr=<N>)` via stdio MCP. The role gate enforces that only the `coordinator`, `pr-reviewer`, and `dev-agent` roles can read these tools.

### Recovery

**If the branch name doesn't match the queue glob:**
Rename the branch to match (`fix/`, `plan/`, `feat/`, `chore/`, `design/`), or move the PR to a different queue by swapping the `queue:*` label. Re-applying a label re-evaluates the queue rule on the next Mergify tick.

**If a queue_condition references a CI check that no longer runs:**
Edit `.mergify.yml` and either rename the condition to the live check name or remove it. Commit through the normal PR flow — don't push directly to `main` even when unblocking a stuck queue.

**If Mergify acknowledged but never acted on the PR:**
```bash
# Force a re-evaluation by toggling the label
gh pr edit <PR> --remove-label queue:bug
gh pr edit <PR> --add-label queue:bug
```

**If a queue is deadlocked (multiple PRs waiting, no progress):**
Coordinator role only. Inside a Claude Code session with `MERGIFY_MCP_ROLE=coordinator` in the MCP `.env`, ask:

> "Call `mergify_set_queue_state` with `state='locked'`, `reason='investigating deadlock on queue:feature'`. After I've investigated, I'll ask you to set it back to `unlocked`."

The tool's input schema accepts `state` (one of `locked` / `unlocked`) and `reason` — note `locked`/`unlocked` is the Mergify state vocabulary; "freeze"/"thaw" in casual speech maps to `locked`/`unlocked` in the API. Only the `coordinator` role can invoke this — the `pr-reviewer` and `dev-agent` roles get a role-refusal envelope.

**If a single PR poisoned the queue (kept failing speculative checks):**
Coordinator role only. Ask Claude:

> "Call `mergify_replay_pr` with `pr=<N>`, `reason='speculative checks regressed; replaying'`."

The handler calls Mergify's replay endpoint via the role-gated MCP server, which re-runs queue evaluation for that PR.

**Break-glass paths if MCP is unavailable:**

If the MCP server is itself broken (env-leak guard tripped, credentials expired, build artefacts missing), don't wait — use the escape hatches:

- Mergify web UI at `https://dashboard.mergify.com/github/<org>/queues` lets a human freeze / replay manually.
- `gh api repos/<org>/<repo>/branches/main/protection` can temporarily block all merges via branch protection if every queue is broken.

Then fix the MCP server (see Runbook §3 — MCP credential rotation).

**Note on label-trust:** Only the `pr-reviewer` agent is allowed to apply `queue:*` labels, and only after BLOCKERs=0 + tests-green. If a queue label appears without a matching `agents/_label-log.jsonl` entry, treat it as a trust-boundary breach and investigate `.claude/jak-pipeline/scripts/label-gate-decide.sh` before unblocking the queue.

---

## 2. Jira drift

> **Owned by:** Plan 3 (Jira integration + drift reconciliation pass).

### Symptoms

- A Jira ticket is in the wrong kanban state: e.g. PR merged but ticket still in "PR Review", or branch pushed but ticket still in "Ready to Dev".
- `agents/_jira-retry.json` is growing (rows accumulating, nothing draining).
- `agents/_tick-log.md` has `JIRA_DRIFT:` entries repeating for the same ticket across many ticks.
- `scripts/doctor.sh` exits non-zero with "STUCK: retry queue has items older than 24h".
- A `[JAK-PIPELINE JIRA AHEAD]` comment appeared on a PR — Jira is ahead of GitHub state, probably from a manual board move.

### Diagnosis

```bash
# 1. See what's drifting
cat agents/_jira-drift.json

# 2. Count stuck retry-queue rows
cat agents/_jira-retry.json | wc -l

# 3. See the full retry queue (ticket, state, attempt count)
python3 -c "
import json, sys
for line in open('agents/_jira-retry.json'):
    d = json.loads(line.strip())
    print(d.get('ticket'), '->', d.get('target_state'), 'attempts:', d.get('attempt_count'))
"

# 4. Run doctor.sh for a full health summary
DOWNSTREAM_ROOT=. PLAN3_CHECK=1 bash scripts/jak-pipeline/doctor.sh
```

### Recovery

**If Jira API is reachable but credentials are wrong:**
1. Rotate the API token at `https://id.atlassian.com/manage-profile/security/api-tokens`.
2. Update `.claude/jira/.env` with the new `JIRA_API_TOKEN`.
3. Run `DOWNSTREAM_ROOT=. PLAN3_CHECK=1 bash scripts/jak-pipeline/doctor.sh` — should exit 0.
4. Run the drain manually: `DOWNSTREAM_ROOT=. bash scripts/jak-pipeline/jira/drain-retry-queue.sh`.

**If a specific ticket is stuck (retry queue row):**
```bash
# Force-transition manually (bypasses retry queue)
bash scripts/jak-pipeline/jira/transition.sh \
  --project SCRUM \
  --ticket SCRUM-NNN \
  --to "In Development" \
  --reason "manual-recovery"
```

**If the retry queue is large:**
```bash
# Drain the full queue; exits 0 even when individual transitions fail
DOWNSTREAM_ROOT=. bash scripts/jak-pipeline/jira/drain-retry-queue.sh
```

**If Jira credentials need full rotation (leaked token):**
- Follow the "§3. MCP credential rotation" runbook for token revocation/re-issue (parallel procedure for Jira creds: revoke token in Atlassian admin console, re-issue, update `.claude/jira/.env`).

**Note on "JIRA AHEAD" alerts:** If Jira is ahead of GitHub state (manual board move), no auto-correction is applied. Resolve by either (a) moving the Jira ticket back to match GitHub state, or (b) accepting the discrepancy and letting the next merged PR advance the state naturally.

---

## 3. MCP credential rotation

> **Owned by:** Plan 1 (Mergify MCP server + redaction wrapper).

### Symptoms

- Every Mergify MCP tool call returns `error: "[REDACTED]"` with no useful detail — the redaction wrapper is masking a credential-failure message.
- The MCP server exits at startup with `env-leak guard tripped` — a credential file accidentally landed inside the jak-pipeline repo root or `mcp/mergify/`.
- A 401 / 403 surfaces on every Mergify call (token expired or revoked); a 404 on every GitHub call (token scope shrunk).
- Suspected credential leak: a token appeared in a logged error envelope before the redaction wrapper was added, or appeared in a git commit caught by `scripts/hooks/pre-commit`.

### Diagnosis

```bash
# 1. Check the credentials file exists at the correct path (must NOT be inside the repo)
DOWNSTREAM_ROOT=$(pwd)
ls -la "$DOWNSTREAM_ROOT/.claude/mcp/mergify/.env"

# 2. Verify all four required keys are present (no values printed — redaction-safe)
for KEY in MERGIFY_API_KEY MERGIFY_ORG GITHUB_TOKEN MERGIFY_MCP_ROLE; do
  grep -qE "^${KEY}\s*=" "$DOWNSTREAM_ROOT/.claude/mcp/mergify/.env" \
    && echo "  ✓ $KEY" || echo "  ✗ MISSING $KEY"
done

# 3. Run doctor.sh — it imports the redaction wrapper and validates the env file
DOWNSTREAM_ROOT=. bash scripts/jak-pipeline/doctor.sh

# 4. Bypass redaction for a single diagnostic call (DEBUG mode only — never commit)
#    Temporarily edit src/redaction.ts to passthrough, rebuild, restart, then revert.
```

### Recovery

**If a token expired (normal rotation):**
1. Generate a new token in the respective provider:
   - **Mergify:** `https://dashboard.mergify.com/github/<org>/settings/api-keys` → "Create new key".
   - **GitHub:** `https://github.com/settings/tokens` (or `.../tokens?type=beta` for fine-grained) → scopes `repo` + `read:org`.
2. Update `<downstream>/.claude/mcp/mergify/.env` — replace the matching `MERGIFY_API_KEY=` or `GITHUB_TOKEN=` line.
3. Restart the MCP server (Claude Code re-spawns it on next dispatch — explicit restart not required).
4. Run `mergify_get_queue_summary` to confirm.

**If a token leaked (revoke immediately, then rotate):**
1. **Revoke first, rotate second** — until the old token is dead it's an active credential. Mergify: same dashboard, "Revoke". GitHub: token page → "Delete".
2. Generate a replacement (steps 1–2 above).
3. Update `.env`, restart, verify.
4. Audit how the leak happened: check `git log --all -p | grep -E '(mrg_live_|mrg_test_|ghp_|github_pat_)'` on the repo it leaked from. If a commit contains it, force-push history with the secret removed (and treat the token as compromised regardless of revocation timing).

**If the env-leak guard tripped at startup:**
The guard refuses to start if it finds credentials in `<jak-pipeline>/.env` or `<jak-pipeline>/mcp/mergify/.env` — those paths are inside the skill repo and would risk a commit. Move the file to `<downstream>/.claude/mcp/mergify/.env` instead. Never disable the guard.

**If the `pre-commit` hook caught a token in a staged diff:**
The hook (`scripts/hooks/pre-commit`) exits non-zero with the matched prefix. Unstage the file, scrub the value, and treat the token as compromised — proceed with the leak-recovery path above. The hook is a backstop, not authorisation to be cavalier.

**Redaction wrapper coverage:** Strips `mrg_live_…`, `mrg_test_…`, `ghp_…`, `ghs_…`, `ghr_…`, `github_pat_…` from every error envelope. If a token of a new format starts appearing in errors, extend `mcp/mergify/src/redaction.ts` and add a test fixture to `tests/redaction.test.ts` in the same PR.

---

## 4. UAT rollback

> **Owned by:** Plan 4 (UAT environment + first install on TnT Finance).

### Symptoms

- UAT rejects a change that has already merged to `main` (the standard fix-forward path via `local-docker-reject.sh` only applies pre-merge, while the PR is still in the `UAT` kanban state).
- The fix-forward path is too slow for the impact (production-facing regression, security bug, data-loss risk).
- Production sees the regression but the UAT environment is still running the same broken image.
- Owner needs to know the rollback is happening before they make a downstream decision.

### Diagnosis

```bash
# 1. Identify the offending merge commit on main
git log --oneline main -10

# 2. Find any open PRs that built on top of it (these may also need rollback)
gh pr list --base main --search "after-merge:<commit-sha>"

# 3. Inspect what the UAT environment is currently running
docker compose -f docker/docker-compose.local-uat.yml ps
docker compose -f docker/docker-compose.local-uat.yml logs --tail=50 app

# 4. Confirm the Jira ticket state — is it Done, or stuck mid-UAT?
bash scripts/jak-pipeline/jira/transition.sh \
  --project <PROJECT> --ticket <TICKET> --dry-run
```

### Recovery — decision tree

**The reject-script path (`local-docker-reject.sh`) is only for pre-merge UAT.** Once a change is on `main`, use one of the two paths below.

**Path A — fix-forward (preferred when fix is small):**
1. Open a `fix/<ticket>-uat-regression` branch from `main`.
2. Implement the fix, push, queue normally (`queue:bug` for priority).
3. Stop the existing UAT stack and bring it up against the new image:
   ```bash
   bash scripts/jak-pipeline/uat/local-docker-stop.sh docker/docker-compose.local-uat.yml
   # … wait for fix-forward PR to merge …
   bash scripts/jak-pipeline/uat/local-docker-start.sh docker/docker-compose.local-uat.yml
   ```
4. Re-run UAT against the new build.

**Path B — revert on main (when fix-forward is too slow):**
1. Coordinator authority only. Generate the revert commit:
   ```bash
   git revert -m 1 <merge-sha>          # for a merge commit
   git revert <commit-sha>              # for a direct commit
   git push origin main                  # if branch protection allows; else PR
   ```
2. Move the originating Jira ticket back to `PR Review` with reason `post-merge UAT rollback`:
   ```bash
   bash scripts/jak-pipeline/jira/transition.sh \
     --project <PROJECT> --ticket <TICKET> --to "PR Review" \
     --reason "post-merge UAT rollback — fix-forward to follow"
   ```
3. Tear down the UAT stack with volume removal so the next start runs against a clean DB:
   ```bash
   bash scripts/jak-pipeline/uat/local-docker-stop.sh \
     docker/docker-compose.local-uat.yml --volumes
   ```
4. Re-deploy UAT against the new (reverted) `main` and re-run acceptance.

### Communicating the rollback

- Comment on the originating PR (now closed) with a link to the revert commit and a one-line rationale.
- Page the Owner via the channel agreed in `references/owner-jql-filters.md` — UAT rollback is not a silent operation.
- Append a one-line entry to `agents/_tick-log.md` so the coordinator records the manual intervention.

### Volumes warning

`local-docker-stop.sh` without `--volumes` preserves the UAT Postgres data. That's usually right (next UAT run sees the same state). For a rollback that includes a schema migration, use `--volumes` to clear the DB; otherwise the rolled-back app may not understand the migrated schema.

---

## 5. Phased rollout rollback

> **Owned by:** Plan 2 (phased per-queue activation + `auto-update-prs.yml` retirement).

### Symptoms

- A queue activated in a phase (per `templates/phase-rollout-commits.md`) is producing regressions: PRs merging without their required checks, mis-routing across queues, or label-trust failures.
- A phase commit needs to be rolled back, but later phases have already landed on top — naïve revert would undo those too.
- `auto-update-prs.yml` was retired on Day 14+ and a queue regression now leaves PRs with no merge engine at all.
- Label-trust enforcement (`scripts/label-gate-decide.sh` BLOCKER=0 + tests-green gate) was tightened mid-phase and is now refusing labels that should pass — pipeline can't move.

### Diagnosis

```bash
# 1. Find the enable-commit for the suspect queue
git log --oneline --all -- .mergify.yml | head -10

# 2. See exactly what each phase commit changed
git show <phase-commit-sha> -- .mergify.yml

# 3. Confirm which queues are currently enabled (disabled: true → disabled)
grep -B 1 "disabled:" .mergify.yml | head -30

# 4. Read the label-gate audit log for refusal patterns
tail -50 agents/_label-log.jsonl | grep '"decision":"refuse"' | python3 -m json.tool
```

### Recovery — per scenario

**A queue is misbehaving (selective rollback, keep other phases):**
Do NOT `git revert` the phase commit if later phases stacked context on top — apply a targeted patch instead. Edit `.mergify.yml`, set `disabled: true` on the offending queue, commit with a `revert:` prefix so the audit trail is searchable:

```bash
# Edit .mergify.yml: set the offending queue back to disabled: true
git add .mergify.yml
git commit -m "revert(mergify): disable queue:feature — regression in <linked-ticket>"
git push origin main      # if protection allows; else PR
```

Subsequent phases stay enabled. Once the root cause is fixed, re-enable via a fresh phase-style commit (same diff shape as the original enable-commit).

**`auto-update-prs.yml` was retired and a queue regression now leaves PRs unhandled:**
Restore the workflow from git history:

```bash
git log --all -- .github/workflows/auto-update-prs.yml | head -5
git show <last-commit-with-file>:.github/workflows/auto-update-prs.yml > \
  .github/workflows/auto-update-prs.yml
git add .github/workflows/auto-update-prs.yml
git commit -m "restore: re-enable auto-update-prs.yml — Mergify queue rollback"
```

This is a temporary safety-net while the queue is fixed. Plan to retire it again with a fresh Day-14+ commit after two green weeks.

**Label-trust enforcement is rejecting valid labels:**
1. Inspect a refused entry: `tail agents/_label-log.jsonl | python3 -m json.tool` — the `reason` field names the failing check.
2. If the check is wrong (e.g. expects `Blockers (N)` format but pr-reviewer is emitting a variant), patch `scripts/label-gate-decide.sh` and ship as a `fix(scripts)` PR.
3. As a temporary unblock for one PR, the coordinator role may apply the `queue:*` label manually — the audit log will mark it as a manual override (`"applied_by":"manual"` instead of `"applied_by":"pr-reviewer"`). Do not normalise manual overrides — every entry should be traceable to the pr-reviewer's gate decision.

**Half-applied phase-rollout-commits cookbook patch:**
If `git apply` partially applied a phase diff and aborted, the file may have stray hunks. Restore from `HEAD`:

```bash
git checkout HEAD -- .mergify.yml
# Then re-apply the phase patch cleanly
git apply templates/phase-rollout-commits.md/phase-N.patch
```

### Volume of concurrent rollbacks

If two phases need to roll back simultaneously, do it as one commit (touch both queues in `.mergify.yml`) rather than two sequential commits — Mergify re-reads the config on push and there's a window where the first revert is active but the second isn't.
