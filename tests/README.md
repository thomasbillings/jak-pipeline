# tests/

Automated tests for the jak-pipeline skill itself (NOT for downstream projects it installs into).

```bash
npm ci                         # from jak-pipeline root
npx vitest run                 # 136 tests across 24 files
npx vitest run --coverage      # with coverage report
```

MCP server tests live in `mcp/mergify/tests/` and run from inside that package; see [`mcp/mergify/README.md`](../mcp/mergify/README.md).

## Plan 1 — Mergify MCP server (in `mcp/mergify/tests/`)

| File | Covers |
| --- | --- |
| `redaction.test.ts` | No Mergify/GitHub token prefix ever appears in any MCP tool's error envelope. |
| `role-gating.test.ts` | Only the `coordinator` role can invoke mutating tools (`mergify_set_queue_state`, `mergify_replay_pr`). |
| `cache.test.ts` | `mergify_get_queue_summary` 30s TTL, `mergify_list_queue_freezes` 60s TTL. |
| `mergify-client.test.ts` | Fetch-based HTTP client error paths. |
| `env-leak-guard.test.ts` | Server refuses to start if credentials are inside the skill repo. |
| `create-server.test.ts` | Server creation + 6-tool registration. |
| `server.test.ts` | Server shape + tool registration (a1, a2). |
| `server-coverage.test.ts` | Additional coverage for error paths and edge cases. |
| `pre-commit-hook.test.ts` | `scripts/hooks/pre-commit` detects all 6 token prefixes in staged diffs. |

## Plan 2 — Mergify config + label trust boundary + branch-ticket binding

| File | Covers |
| --- | --- |
| `tests/templates/mergify-yaml.test.ts` | Parses `.mergify.yml.tmpl`; asserts all 5 queues with priorities/globs/labels/CI gates + global section (a1). |
| `tests/templates/phase-cookbook.test.ts` | One section per phase + each diff applies cleanly via `git apply --check` (a2). |
| `tests/templates/pr-reviewer-overlay.test.ts` | Overlay declares the 4 label rules and invokes `label-gate-decide.sh` (a3). |
| `tests/scripts/label-gate-decide.test.ts` | Six behaviours: role check, queue:plan guard, allowed-set check, BLOCKERS gate, no-review gate, CI check. `gh` stubbed via PATH-shim at `_fixtures/bin/` (a4). |
| `tests/scripts/label-log-append.test.ts` | Appends row with all six required fields; idempotent within same UTC minute via `JAK_NOW_OVERRIDE` (a5, a6). |
| `tests/scripts/branch-ticket-check.test.ts` | Accepts/rejects fixture branch names per `references/architecture.md` §4 regex (a7, a9). |
| `tests/agents/label-trust.test.ts` | Five named trust-boundary cases: `queue:plan` refused, BLOCKERS>0 refused, CI failing refused, injection-guard structural assertion, log writer fields (a8). |

## Plan 3 — Jira integration

| File | Covers |
| --- | --- |
| `tests/jira/transition-shape.test.ts` | Argv shape — `--project`, `--ticket`, `--to`, `--reason` flags. |
| `tests/jira/transition-args.test.ts` | Argument parsing edge cases. |
| `tests/jira/transition-read-before-write.test.ts` | Read current state before posting transition (idempotency contract). |
| `tests/jira/transition-never-backwards.test.ts` | Never moves a ticket backwards in the kanban order. |
| `tests/jira/transition-retry-backoff.test.ts` | Retries 3× with exponential backoff on transient failures. |
| `tests/jira/transition-fall-through.test.ts` | Falls through to `agents/_jira-retry.json` after exhausting retries. |
| `tests/jira/transition-verify-after-write.test.ts` | Re-reads after write to confirm the transition landed. |
| `tests/jira/drift-reconciliation.test.ts` | Drift detection reads Jira state, compares to GitHub PR state, flags mismatches. |
| `tests/jira/drain-retry-queue.test.ts` | Drain script processes `_jira-retry.json` entries in order, removes on success. |
| `tests/jira/provision-board.test.ts` | Idempotent workflow provisioning via `/rest/api/3/workflows/create` + `/workflowscheme/project/switch`. No-ops when the project already has the `jak-pipeline` scheme and all 12 statuses. Board column mapping is a manual UI step on Cloud and is not exercised. |
| `tests/jira/tick-extension-shape.test.ts` | `jak_pipeline_jira_tick_pass` function shape — exit semantics, log output. |
| `tests/jira/owner-jql-filters.test.ts` | JQL filters from `references/owner-jql-filters.md` parse and execute. |
| `tests/jira/install-script.test.ts` | `install.sh` Plan 3 section — temp-dir downstream simulation + idempotence (a16). |
| `tests/jira/doctor-script.test.ts` | `doctor.sh` Plan 3 section validates credentials, retry queue, tick.sh registration. |
| `tests/jira/_stub-jira.ts` | Shared test helper — mock Jira HTTP responses + temp-dir setup. |

Jira outage during a pipeline run never blocks Mergify (architecture contract): if `transition.sh` can't reach Jira, it appends to `_jira-retry.json` and exits 0.

## Plan 4 — UAT + Storybook preview

| File | Covers |
| --- | --- |
| `tests/uat/dispatcher.test.ts` | `run.sh` strategy dispatcher — `none` / `local-docker` / `vercel-preview` / `fly-staging` / unknown (a2). |
| `tests/uat/local-docker-lifecycle.test.ts` | Start/stop/accept/reject — Docker and `transition.sh` mocked (a3–a6). Asserts `local-docker-accept.sh` always tears down even when Jira fails. |
| `tests/uat/storybook-preview.test.ts` | `templates/github-actions/storybook-preview.yml` shape — draft-skip rule, CF_PAGES_PROJECT env, CF_API_TOKEN secret, `--only-changed`, no TnT-specific hardcoding (a7, a11). |
| `tests/uat/_helpers.ts` | Shared test helpers — `makeMockBin`, `makeMockDocker`, `runScript`, `templatePath`. |
