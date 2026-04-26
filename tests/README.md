# tests/

Automated tests for the jak-pipeline skill itself (NOT for downstream projects it installs into).

Run all tests:

```bash
npm run test          # from jak-pipeline root
npm run test:coverage # with coverage report
```

## Plan 1 — Mergify MCP server

Tests live in `mcp/mergify/tests/` (inside the MCP package):

- `mcp/mergify/tests/redaction.test.ts` — assert no Mergify or GitHub token ever appears in any MCP tool's error envelope.
- `mcp/mergify/tests/role-gating.test.ts` — assert `MERGIFY_MCP_ROLE=pr-reviewer` cannot invoke `mergify_set_queue_state`; coordinator role can.
- `mcp/mergify/tests/cache.test.ts` — queue_summary 30s TTL, queue_freezes 60s TTL.
- `mcp/mergify/tests/mergify-client.test.ts` — real fetch-based client tests.
- `mcp/mergify/tests/env-leak-guard.test.ts` — env leak prevention.
- `mcp/mergify/tests/create-server.test.ts` — server creation and tool registration.
- `mcp/mergify/tests/server.test.ts` — server shape (a1, a2).
- `mcp/mergify/tests/server-coverage.test.ts` — additional coverage tests.
- `mcp/mergify/tests/pre-commit-hook.test.ts` — pre-commit hook validation.

## Plan 2 — Mergify config + label trust boundary + branch-ticket binding

Tests live in `tests/agents/`, `tests/scripts/`, and `tests/templates/`:

- `tests/templates/mergify-yaml.test.ts` — parse `.mergify.yml.tmpl`, assert all 5 queues with priorities/globs/labels/CI gates and the global section (a1).
- `tests/templates/phase-cookbook.test.ts` — assert one section per phase + each diff applies cleanly via `git apply --check` (a2).
- `tests/templates/pr-reviewer-overlay.test.ts` — assert the overlay declares the four label rules and invokes `label-gate-decide.sh` (a3).
- `tests/scripts/label-gate-decide.test.ts` — exhaustive over the six behaviours (role check, queue:plan guard, allowed-set check, BLOCKERS gate, no-review gate, CI check) with `gh` stubbed via PATH-shim at `tests/_fixtures/bin/` (a4).
- `tests/scripts/label-log-append.test.ts` — appends row with all six required fields; idempotent within same UTC minute via `JAK_NOW_OVERRIDE` (a5, a6).
- `tests/scripts/branch-ticket-check.test.ts` — accepts/rejects fixture branch names per architecture §4 regex (a7, a9).
- `tests/agents/label-trust.test.ts` — five named trust-boundary cases: queue:plan refused, BLOCKERS>0 refused, CI failing refused, injection-guard structural assertion, log writer fields (a8).

## Plan 3 — Jira integration (upcoming)

- `tests/jira/idempotency.test.ts` — read-before-write, never-backwards, retry 3× exponential backoff, fall-through to `_jira-retry.json`.
- `tests/jira/never-blocks-pipeline.test.ts` — Jira outage does NOT stall a Mergify merge.

## Plan 4 — UAT + Storybook preview (upcoming)

UAT + Storybook preview tests as appropriate to the chosen strategies.
