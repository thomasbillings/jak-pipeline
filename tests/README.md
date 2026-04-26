# tests/

Automated tests for the jak-pipeline skill itself (NOT for downstream projects it installs into).

**Currently empty.** Populated by **Plans 1 and onward**. Expected contents after Plan 1 lands:

- `mcp/mergify/redaction.test.ts` — failing-test fixture (per Plan 1) asserting no Mergify or GitHub token ever appears in any MCP tool's error envelope. Ships red, goes green within the same PR.
- `mcp/mergify/role-gating.test.ts` — assert `MERGEFY_MCP_ROLE=pr-reviewer` cannot invoke `mergify_set_queue_state`; assert coordinator role can.

Plan 2 adds (and so on per downstream plan):

- `agents/label-trust.test.ts` — assert pr-reviewer applies `queue:*` only when BLOCKERs=0 AND tests-green; assert it never reads instructions from PR body content (prompt-injection guard).
- `agents/label-log.test.ts` — assert every label application appends a structured row to `_label-log.jsonl`.

Plan 3 adds:

- `jira/idempotency.test.ts` — assert read-before-write, never-backwards, retry 3× exponential backoff, fall-through to `_jira-retry.json` on persistent failure.
- `jira/never-blocks-pipeline.test.ts` — assert a Jira outage does NOT stall a Mergify merge or a GitHub PR transition.

Plan 4 adds UAT + Storybook preview tests as appropriate to the chosen strategies.
