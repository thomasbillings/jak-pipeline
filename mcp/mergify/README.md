# Mergify MCP Server

TypeScript stdio MCP server exposing Mergify queue operations to Claude agents. Six role-gated tools, redaction wrapper on every error envelope, and an env-leak guard that refuses to start if credentials are detected in the repo.

## Install

```bash
cd mcp/mergify
npm install
npm run build    # produces dist/
```

Run the server (from an agent's MCP config):

```json
{
  "command": "node",
  "args": ["dist/server.js"],
  "env": {
    "MERGIFY_API_KEY": "...",
    "MERGIFY_ORG": "...",
    "GITHUB_TOKEN": "...",
    "MERGIFY_MCP_ROLE": "coordinator"
  }
}
```

## Required environment variables

| Variable           | Purpose                                                              | Where the real value lives                        |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------- |
| `MERGIFY_API_KEY`  | Mergify API key (`mrg_live_…` or `mrg_test_…`)                      | `<downstream>/.claude/mcp/mergify/.env`           |
| `MERGIFY_ORG`      | GitHub org/user name that owns the repos                             | `<downstream>/.claude/mcp/mergify/.env`           |
| `GITHUB_TOKEN`     | GitHub PAT (`ghp_…` or `github_pat_…`), `repo` + `read:org` scopes  | `<downstream>/.claude/mcp/mergify/.env`           |
| `MERGIFY_MCP_ROLE` | Role for this dispatch (`coordinator`, `pr-reviewer`, etc.)          | Injected at agent dispatch (not stored in `.env`) |

## Role-gate matrix

Sourced from `references/architecture.md §6`.

| Tool                               | coordinator | pr-reviewer | dev-agent | planner |
| ---------------------------------- | :---------: | :---------: | :-------: | :-----: |
| `mergify_get_queue_summary`        | ✅          | ✅          | ✅        | ✅      |
| `mergify_get_queue_details(pr)`    | ✅          | ✅          | ✅        | —       |
| `mergify_check_pr_eligibility(pr)` | ✅          | ✅          | ✅        | —       |
| `mergify_list_queue_freezes`       | ✅          | ✅          | —         | —       |
| `mergify_set_queue_state`          | ✅ (only)   | —           | —         | —       |
| `mergify_replay_pr`                | ✅ (only)   | —           | —         | —       |

An unrecognised or absent `MERGIFY_MCP_ROLE` causes every tool to refuse with `role-unrecognised`.

## Redaction wrapper

Every tool handler wraps its error envelope through `src/redaction.ts` before returning. The following token prefixes are stripped from the `error` field and all nested `details` values:

- `mrg_live_…` — Mergify production API key
- `mrg_test_…` — Mergify staging API key
- `ghp_…` — GitHub classic PAT
- `ghs_…` — GitHub Actions session token
- `ghr_…` — GitHub refresh token
- `github_pat_…` — GitHub fine-grained PAT

A leaked token in an HTTP error response body, a stack trace, or a header value will appear as `[REDACTED]` in the tool's output. `tests/redaction.test.ts` verifies this exhaustively for all six prefixes.

## Env-leak guard

The server calls `checkEnvLeakGuard()` at startup. If it detects credential keys (`MERGIFY_API_KEY`, `MERGIFY_ORG`, `GITHUB_TOKEN`, `MERGIFY_MCP_ROLE`) in either:

- `~/code/jak-pipeline/.env`
- `~/code/jak-pipeline/mcp/mergify/.env`

it exits non-zero with a message naming the offending file. Place credentials at `<downstream-project>/.claude/mcp/mergify/.env` instead — that path is outside the guard's scope.

## Pre-commit hook

`scripts/hooks/pre-commit` scans staged diffs for token prefixes (`gh[psr]_`, `github_pat_`, `mrg_live_`, `mrg_test_`). Install it manually in either the skill repo or any downstream that hosts credentials:

```bash
ln -sf ../../scripts/hooks/pre-commit .git/hooks/pre-commit
```

> **Note:** `scripts/install.sh` does NOT install this hook automatically. The install-side wiring for the MCP server (which would include hook installation) is still a TODO — tracked as a follow-up in [`SKILL.md`](../../SKILL.md#status).

## Tests

```bash
npm run test              # all 81 unit tests across 9 files
npm run test:coverage     # with coverage report
```
