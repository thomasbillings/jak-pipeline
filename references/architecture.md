# jak-pipeline architecture (decided)

This document is the architecture-of-record for `jak-pipeline`. It is the curated output of a 10-voice discovery panel + Tier-Best convergence pass, captured as decisions. Plans 1-4 implement against this; if a downstream plan needs to deviate, that plan amends this file in the same PR — never silently.

Where the discovery panel did not converge on a specific value, the section says **OPEN** and names the downstream plan that resolves it. Open items are listed in §13.

## 1. Overview

A small-team-grade delivery pipeline for a single developer plus Claude agents. The unit of work is a Jira ticket; its state machine is the 12-state kanban. GitHub PR state is canonical; Mergify and Jira are projections. Mergify enforces a named-queue merge policy; the Mergify MCP server lets agents inspect (and the coordinator alone mutate) the queue. Jira is reconciled idempotently — a Jira outage never blocks the GitHub pipeline. UAT is a pluggable gate between merge-to-main and Done; Storybook gets a preview per PR.

The pipeline is delivered by 5 plans. Plan 0 (this scaffold) lays out the directory tree and decided architecture. Plans 1-4 build the Mergify MCP server, Mergify config + agent label transitions, Jira integration, and the first install on TnT Finance respectively.

## 2. Kanban states (12)

Full state machine, transitions, and Mermaid diagram live in [`kanban-states.md`](kanban-states.md). Summary:

- **Mainline (10):** Idea → Backlog → Planning → Plan Review → Ready to Dev → In Development → PR Review → Merge Queue → UAT → Done.
- **Sidebar swimlane (1):** Blocked — reachable from any mainline state, retains `blocked_from`, returns to it on unblock.
- **Terminal (1):** Cancelled.
- **Backward edges:** Plan Review → Planning (rejection); PR Review → In Development (BLOCKER); Merge Queue → PR Review (Mergify dequeue); UAT → PR Review (UAT reject, fix-forward — never auto-revert).
- **Re-entry rule for Done:** Done is terminal. Follow-up work files a NEW ticket; existing tickets never re-open.

## 3. Reconciliation policy

**GitHub PR state is canonical.** Mergify's queue and Jira's board are projections.

- Mergify is the policy engine on top of GitHub: it cannot move state in any direction GitHub doesn't already permit (it can dequeue, merge, or hold; it cannot un-merge).
- Jira is the human-readable projection: it carries no decision authority. Every Jira transition is computed from GitHub state.
- The coordinator's `tick.sh` runs a reconciliation pass on every tick:
  - Read GitHub PR state for every open + recently-merged PR.
  - Compute the expected Jira state for each.
  - Diff against actual Jira state.
  - If drift > 10 minutes, post a comment on the PR (audit trail) AND force-transition Jira to match GitHub.
  - **Never reverse.** The reconciler does not auto-merge or auto-close; it only writes Jira to match GitHub.
- Drift events are logged in `agents/_tick-log.md`.

## 4. Branch-ticket binding

Every branch is bound to a Jira ticket key by name. Enforced at PR creation; unbound PRs are rejected by the pre-PR hook.

**Regex:**

```
^(plan|feat|fix|chore|design|docs|test)/(SCRUM-\d+|GH-\d+)-[a-z0-9-]+$
```

- Prefix segment matches the queue family (`plan`, `feat`, `fix`, `chore`, `design`) or a non-queueing class (`docs`, `test`).
- Middle segment is the durable ticket key. `SCRUM-\d+` for Jira, `GH-\d+` for GitHub-issue-only flows.
- Tail is a kebab-case slug for human readability.

The plan file's frontmatter also carries `jira_key` so the dev-agent can re-emit the bound branch name from the plan alone. **Branch name is the immutable binding** — PR descriptions, labels, and Jira fields are all rewriteable; the branch name is not. (Pipeline Choreographer mandate.)

## 5. Mergify queues (5 named)

Five named queues with priorities. Lower priority is shed first under contention; the highest priority queue drains first.

| Queue       | Branch glob | Label           | CI gate                      | Priority |
| ----------- | ----------- | --------------- | ---------------------------- | -------- |
| `bug`       | `fix/*`     | `queue:bug`     | full CI (lint + unit + e2e)  | **4** (highest) |
| `plan`      | `plan/*`    | `queue:plan`    | lint + `check-plan.sh` only  | **3**    |
| `feature`   | `feat/*`    | `queue:feature` | full CI                      | **2**    |
| `infra`     | `chore/*`   | `queue:infra`   | lint + unit (no e2e)         | **1**    |
| `design`    | `design/*`  | `queue:design`  | lint + unit (fast lane; **no UAT, no plan**) | **0** (lowest) |

**Global merge config (applies to every queue):**

- `Sequential` (no parallel batches across the same queue).
- `batch_size: 1` (one PR per merge action — straightforward attribution).
- `update_method: rebase` (defeats force-push-during-queue races; Red Team mandate).
- `Squash` merge into main (single commit per PR; clean history).
- `speculative_checks: 1` (test the queued state, not just the head).
- `check-success-or-neutral` for each required check.
- `allow_inplace_checks: true` (let same-SHA checks count without re-running).

The `design` queue's "no UAT, no plan" exemption is for low-blast-radius visual-only work (CSS tokens, copy tweaks) where the cost of a UAT cycle exceeds the risk it mitigates. Eligibility for `design/*` branches is enforced at PR creation by the same pre-PR hook that enforces the regex.

## 6. Mergify MCP server (6 role-gated tools)

A TypeScript stdio MCP server lives in `mcp/mergify/` (Plan 1). Six tools, role-gated by the `MERGIFY_MCP_ROLE` env var injected at agent dispatch.

| Tool                            | Cache TTL    | coordinator | pr-reviewer | dev-agent | planner |
| ------------------------------- | ------------ | ----------- | ----------- | --------- | ------- |
| `mergify_get_queue_summary`     | 30s          | ✅          | ✅          | ✅        | ✅      |
| `mergify_get_queue_details(pr)` | none         | ✅          | ✅          | ✅        | —       |
| `mergify_check_pr_eligibility(pr)` | none      | ✅          | ✅          | ✅        | —       |
| `mergify_list_queue_freezes`    | **OPEN — Plan 1** | ✅     | ✅          | —         | —       |
| `mergify_set_queue_state(state, reason)` | none | ✅ (only)   | —           | —         | —       |
| `mergify_replay_pr(pr, reason)` | none         | ✅ (only)   | —           | —         | —       |

**Role-gating rule:**

- coordinator gets all 6 tools (only role with mutating capability).
- pr-reviewer is read-only: summary + details + eligibility + freezes.
- dev-agent gets summary + details + eligibility (enough to debug a stuck PR; cannot replay).
- planner gets summary only (situational awareness).

**Env file location:** `<downstream-project>/.claude/mcp/mergify/.env` — NOT the repo `.env`. The wrapper REFUSES to start if the credentials live in the repo `.env` (a leak guard).

**Mandatory redaction wrapper** on every error envelope (Plan 1 ships a failing-test fixture asserting the Mergify token never appears in any tool's output, even on error). Pre-commit hook scanning for token prefixes lives in `scripts/` (Plan 1).

## 7. Trust boundaries (label authority + audit log)

The pipeline's safety hinges on who can apply `queue:*` labels.

| Label             | Who can apply                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `queue:plan`      | **USER ONLY.** Replaces manually merging the plan PR as the approval signal. The user applying this label IS the approval. |
| `queue:bug`       | `pr-reviewer` agent, gated on its **own** structured BLOCKERs=0 + tests-green check.                                       |
| `queue:feature`   | `pr-reviewer` agent, same gate.                                                                                            |
| `queue:infra`     | `pr-reviewer` agent, same gate.                                                                                            |
| `queue:design`    | `pr-reviewer` agent, same gate (CI gate is lighter, but label-authority gate is identical).                                |

**Critical injection guard (Red Team mandate):** the pr-reviewer's gate reads its OWN structured output (its rendered comment + `gh` API view of its own posted reviews), NOT free-form PR body or comment content. PR body content is treated as untrusted and never controls a label decision.

**Audit log contract:** every label application appends a row to `agents/_label-log.jsonl` with:

- `applied_by` — agent ID (or user ID if user-applied).
- `pr_number`.
- `label`.
- `blocker_count` — at the time of application (0 for agent-applied; N/A for user-applied).
- `tests_state` — `green` / `red` / `neutral` at time of application (N/A for user-applied).
- `reasoning` — short text from the agent's gate decision.
- `applied_at` — ISO 8601.

Writer is whichever actor applied the label. For `queue:plan` (user-applied), the coordinator's next tick observes the new label and writes a `applied_by: user` row retrospectively (not contractual — surfaces user actions in the audit trail without requiring user-side automation).

## 8. Jira idempotency contract

Every Jira transition the pipeline writes is:

1. **Read-before-write** — fetch current Jira state, abort if already at target state.
2. **Never backwards** — refuse a transition that moves the ticket backwards on the kanban (backward edges in the state machine are GitHub-driven; Jira receives the result, never initiates it).
3. **Verify-after-write** — re-fetch and assert the new state matches.
4. **Retry 3× exponential backoff** on transient Jira failures. Backoff seed/cap: **OPEN — Plan 3**.
5. **Fall through to `agents/_jira-retry.json`** on persistent failure. The retry queue is JSONL-shaped (one pending transition per line); the coordinator's `tick.sh` drains it on each tick.
6. **NEVER block the GitHub pipeline on Jira failure.** Mergify merges, dev-agents push, and pr-reviewers approve regardless of Jira's state. Jira drift is a reportable condition (post a PR comment on >10min drift, per §3) but not a pipeline-stopper.

Shared helper: `scripts/jira/transition.sh` (Plan 3). Every agent + the coordinator call this helper rather than hitting the Jira API directly.

## 9. UAT pluggable strategies (4)

UAT is a gate between Merge Queue and Done. Four strategies are supported; each downstream project picks one in its install config.

| Strategy          | When to pick                                              | Default for      |
| ----------------- | --------------------------------------------------------- | ---------------- |
| `local-docker`    | Project has a Docker Compose stack already.               | **TnT Finance**  |
| `vercel-preview`  | Frontend-heavy projects already on Vercel.                | (project's call) |
| `fly-staging`     | Projects with a hosted staging stack on Fly.io.           | (project's call) |
| `none`            | Small projects where UAT is overhead, not insurance.       | (project's call) |

**Behaviour when UAT rejects:** the original PR is already merged to main. The pipeline does NOT auto-revert. Instead the ticket goes back to PR Review and the dev-agent opens a fix-forward PR on a new branch. The original feature PR stays merged in the history; the fix-forward PR carries the fix.

**TnT Finance specifics (Plan 4 install):** the `local-docker` strategy stands up a second Dockerized stack (separate Postgres) on the dev machine or NAS, listening on port 9670 (one port off the dev server's 9669). Production deploy is gated on the user transitioning UAT → Done — no auto-promote.

## 10. Storybook preview hosting (4)

Storybook gets a per-PR preview so reviewers can poke at component changes before merge.

| Host              | Setup cost / latency                                              | Default for     |
| ----------------- | ----------------------------------------------------------------- | --------------- |
| `cloudflare-pages` | Low setup (one CF Pages project); ~2-2.5 min push-to-live.      | **TnT Finance** |
| `vercel`          | Medium setup; fast deploys.                                       | (project's call) |
| `github-pages`    | Lowest setup; slowest (~3-5 min); ugly URL.                       | (project's call) |
| `self-host-nas`   | Highest setup; maximal control.                                   | (project's call) |

**Draft-skip rule (mandatory across all hosts):** Storybook preview build is SKIPPED on draft PRs. The build runs only when the PR is marked ready-for-review. This avoids burning CI on WIP commits.

**`--only-changed` fast lane:** for tweaks that touch one or two stories, the workflow uses Storybook's `--only-changed` flag to cut build time to ~30-40s.

## 11. Phased activation timeline

The full Mergify config is committed on Day 0 with every queue marked `disabled: true`, so the legacy `auto-update-prs.yml` workflow continues to handle merges. Each subsequent phase enables one queue (or one cohort of queues). Roll back by reverting the per-queue enable commit.

| Phase     | Date         | Action                                                                                       |
| --------- | ------------ | -------------------------------------------------------------------------------------------- |
| **Day 0** | install day  | Commit `.mergify.yml` with all queues `disabled: true`. `auto-update-prs.yml` still runs.    |
| **Day 1-2** | +1 day     | Enable `queue:plan`. Plan PRs now route through Mergify; everything else still uses legacy.  |
| **Day 3-5** | +3 days    | Enable `queue:infra`. Chore PRs join.                                                         |
| **Day 6-13** | +6 days   | Enable `queue:feature`, `queue:bug`, `queue:design` together. Full cutover for code PRs.     |
| **Day 14+** | +14 days   | After 2 green weeks, delete `auto-update-prs.yml`. Mergify is the sole merge engine.         |

**Rollback recipe:** `git revert <enable-queue-X commit>` — reverting the enable commit puts queue X back to `disabled: true` without touching the other queues. The legacy workflow doesn't need to be reinstated unless ALL queues end up disabled, in which case revert the Day-14 deletion commit too.

Per-queue enable order within Day 6-13 (feature vs bug vs design first): **OPEN — Plan 2 author's call.** Bundled together in the spec because the conflict surface between them is small.

## 12. Owner deliverables

The pipeline produces four artefacts the Owner consults regularly.

1. **Stale-work JQL filter URL** — Jira saved filter surfacing tickets that have been in any non-terminal state > 7 days. Exact JQL: **OPEN — Plan 3.** Goes in the Owner's bookmarks.
2. **Agent-claimed-work JQL filter URL** — Jira saved filter surfacing tickets currently being worked on by an agent (anything in In Development / PR Review / Merge Queue). Exact JQL: **OPEN — Plan 3.**
3. **Weekly cost report** at `agents/_cost-report.md` — Mergify queue actions per week + Anthropic spend per merged PR. Owned by Plan 3 or 4 (TBD by Plan 3 author when they pick this up; defer to Plan 4 if Plan 3 stays focused on Jira plumbing).
4. **Failure-escalation contract** — any silent handoff > 10 minutes (e.g. dev-agent posts a `COORDINATOR: please dispatch X` comment but no tick fires within 10 min, or a Jira retry queue grows without draining) fires a notification on **ntfy or Slack** (either is acceptable; the choice is made by whichever downstream plan picks up the contract — recorded in this file when chosen).

## 13. Open items (decisions deferred to downstream plans)

Tracked here so a future implementer can see at a glance what's still unsettled.

| Open item                                            | Resolved by                  |
| ---------------------------------------------------- | ---------------------------- |
| `mergify_list_queue_freezes` cache TTL               | Plan 1                       |
| Jira retry exponential-backoff seed and cap          | Plan 3                       |
| Per-queue enable order within Day 6-13               | Plan 2                       |
| Cost-report owner (Plan 3 vs Plan 4)                 | Plan 3 author claims or punts |
| Failure-escalation transport (ntfy vs Slack vs both) | Whichever downstream plan picks up escalation |
| Exact JQL strings for Owner's two filter URLs        | Plan 3                       |

## 14. Source provenance

This file curates decisions originally captured in the `jak-pipeline` discovery panel session. The canonical transcript is `~/.claude/projects/-Users-tombone-code-TnT-Finance/ea9e09c0-195e-42c2-8632-40626d316f8d.jsonl`:

- Master spec (Tier-Best converged brief): line 738.
- 10-voice panel digest (every persona's mandate): line 290.
- 9-stage actor map (precursor to the 12 states): lines 100-129.
- UAT design discussion: lines 580-605.
- Design fast-lane discussion: lines 627-643.
- Storybook preview options: lines 700-733.
- Supersession table (was → now): lines 663-672.
- 5-plan delivery sequence: lines 676-684.

Plans 1-4 may amend this file when they refine a decision; doing so is part of those plans' diff and is plan-reviewer-visible. Silent drift is a defect.
