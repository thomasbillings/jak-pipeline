# Security Policy

`jak-pipeline` is a delivery-pipeline skill that handles GitHub PATs, Mergify API keys, Jira API tokens, and Cloudflare API tokens. Vulnerabilities in this codebase can leak production credentials or grant unauthorised access to downstream repos and queues. Please take them seriously.

## Supported versions

`jak-pipeline` follows trunk development; security fixes target `main` and downstream installs refresh on the next install. There is no separate LTS branch.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.** Use one of:

1. **GitHub private vulnerability reporting** (preferred): open `https://github.com/thomasbillings/jak-pipeline/security/advisories/new`. This routes to the maintainer privately.
2. **Email**: `thomas.billings@gmail.com` with subject `jak-pipeline security:` and a clear reproduction.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, with command-line invocations or the smallest possible PR / diff.
- Affected versions (commit SHA on `main` is fine; the skill doesn't tag releases).
- Any mitigations or workarounds you've identified.

You will receive an acknowledgement within 7 days. We aim to triage within 14 days and ship a fix on `main` within 30 days for high-severity findings, faster for actively-exploited issues.

## In-scope surface

The following are the most security-sensitive areas. Findings here are highest-priority:

- **`mcp/mergify/src/redaction.ts`** — strips Mergify and GitHub token prefixes from MCP error envelopes. A bypass here exposes tokens to any agent that can read MCP errors. See `references/recovery-runbooks.md` §3 (MCP credential rotation).
- **`mcp/mergify/src/role-gate.ts`** — role-based access control over the 6 MCP tools. A bypass elevates a `pr-reviewer` or `dev-agent` role to `scrum-master` and lets them mutate the merge queue.
- **`mcp/mergify/src/env-leak-guard.ts`** — refuses to start if credentials are detected in the skill repo. A bypass means a misplaced `.env` could be inadvertently committed.
- **`scripts/hooks/pre-commit`** — scans staged content for token prefixes (`gh[psroue]_`, `github_pat_`, `mrg_live_`, `mrg_test_`). Missing prefix coverage is a defense-in-depth gap, not a critical bypass.
- **`scripts/jira/transition.sh`** — handles `JIRA_API_TOKEN`. Injection via crafted ticket-key or reason argument would be a credential-handling issue.
- **`scripts/scrum-master/dispatch.sh`** — spawns headless agent processes with session-IDs derived from `uuidgen`/`python3`. UUID predictability or path-traversal in `slug` arguments are in scope.
- **`scripts/label-gate-decide.sh`** — the trust boundary that authorises agent-applied `queue:*` labels. A bypass allows un-reviewed code to enter the merge queue.

## Out of scope

- Issues in downstream projects that install `jak-pipeline`. Report those to the downstream project.
- Issues in the underlying tools (`gh`, `git`, `python3`, `node`, `docker`, `mergify`, `jira`).
- Findings that require pre-existing access to a developer's machine, container, or `claude.ai` session.
- Configuration errors that are documented as user-responsibility (e.g., leaking your own GitHub PAT into a public commit despite the pre-commit hook).
- Defaults that the user has explicitly overridden (e.g., `JAK_SKIP_PREFLIGHT=1`).

## Disclosure policy

Once a fix is merged to `main` and a tagged commit is identified, we will:

1. Publish a GitHub Security Advisory describing the issue, affected commit range, and the fix.
2. Credit the reporter (with their consent) on the advisory.
3. Notify any known downstream installs via the install-on-update flow (the user re-runs `install.sh` to refresh).

We do not currently issue CVEs. If a finding warrants one, the reporter is welcome to request one independently.

## Hall of thanks

If you report a vulnerability and it is resolved, you will be listed here (with consent).

_(none yet)_
