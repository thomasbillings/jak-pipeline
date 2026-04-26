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
>
> **Symptoms it should cover:** ticket state on the board diverges from PR state on GitHub (e.g. PR is merged but ticket is still in PR Review), idempotent transition helper failing silently, `agents/_jira-retry.json` queue growing unbounded, drift reconciliation pass in `tick.sh` failing to converge.
>
> Body to be populated by Plan 3.

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
