# Recovery runbooks (jak-pipeline)

This file holds operational recovery procedures for the jak-pipeline. Every runbook is currently a placeholder header — bodies are populated by the downstream plan that owns the failure mode it covers.

> **Empty body ≠ "we forgot."** An empty section means the downstream plan listed under "Owned by" has not landed yet. When it lands, that plan's PR fills in the body of its assigned section in this file.

---

## 1. Mergify queue stuck

> **Owned by:** Plan 2 (Mergify config + agent label transitions).
>
> **Symptoms it should cover:** queue not draining, `queue:*` label applied but no merge action visible, queue rule mismatched against branch glob, conditions never satisfied because of a misconfigured CI gate.
>
> Body to be populated by Plan 2.

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
>
> **Symptoms it should cover:** Mergify or GitHub token expiry inside the MCP env file, redaction wrapper masking error output so the token error is invisible, rotating tokens without restarting the MCP server, recovering from a leaked token by full revoke + re-issue.
>
> Body to be populated by Plan 1.

---

## 4. UAT rollback

> **Owned by:** Plan 4 (UAT environment + first install on TnT Finance).
>
> **Symptoms it should cover:** UAT rejects a change after it has merged to main, fix-forward path is too slow, taking the UAT environment back to the last-known-good commit, communicating the rollback to the Owner, decision tree for revert-on-main vs fix-forward.
>
> Body to be populated by Plan 4.

---

## 5. Phased rollout rollback

> **Owned by:** Plan 2 (phased per-queue activation + `auto-update-prs.yml` retirement).
>
> **Symptoms it should cover:** a queue activated in a phase causes regressions, rolling back a queue without losing the others' progress, restoring the legacy `auto-update-prs.yml` workflow if it was retired in the same window, recovering from a half-applied label-trust enforcement change.
>
> Body to be populated by Plan 2.
