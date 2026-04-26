# mcp/mergify/

Source for the Mergify Model Context Protocol (MCP) server that the pipeline's agents use to inspect and (in the coordinator's case) operate the Mergify queue.

**Currently empty.** Populated by **Plan 1** (Mergify MCP server source + redaction wrapper). Expected contents after Plan 1 lands:

- TypeScript stdio MCP server exposing the 6 role-gated tools enumerated in `references/architecture.md` §6:
  - `mergify_get_queue_summary` (cached 30s, available to all agents)
  - `mergify_get_queue_details(pr)` (no cache)
  - `mergify_check_pr_eligibility(pr)` (no cache)
  - `mergify_list_queue_freezes` (TTL TBD by Plan 1)
  - `mergify_set_queue_state(state, reason)` (coordinator-only)
  - `mergify_replay_pr(pr, reason)` (coordinator-only)
- Role gate read from `MERGIFY_MCP_ROLE` env var injected at agent dispatch.
- Mandatory redaction wrapper on every error envelope so a leaked Mergify or GitHub token never surfaces in transcripts.
- Failing-test fixture asserting the token never appears in any tool's error output (test-driven; ships red and goes green inside Plan 1).
- `.env.example` documenting the credentials the wrapper consumes (the real env file is created at `<downstream>/.claude/mcp/mergify/.env`, NOT in the repo).

Pre-commit hook scanning for token prefixes (also Plan 1) lives elsewhere; see Plan 1 for placement.
