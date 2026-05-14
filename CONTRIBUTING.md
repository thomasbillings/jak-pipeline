# Contributing to `jak-pipeline`

Thanks for considering a contribution. This document covers the practical conventions; the architecture and design rationale are in [`SKILL.md`](SKILL.md) and [`references/architecture.md`](references/architecture.md).

## How to contribute

1. **For non-trivial changes, open an issue first.** A 5-minute back-and-forth on direction saves both of us time. For typo fixes or one-line corrections, jump straight to a PR.
2. **For security issues, do NOT open a public issue.** See [`SECURITY.md`](SECURITY.md) for the private disclosure path.
3. **Fork → branch → PR.** The `main` branch is protected; direct pushes are blocked. Every change goes through a PR with passing CI.

## Branch naming

The branch name matches the change type and routes the eventual feature PR to the corresponding Mergify named queue (per [architecture.md §5](references/architecture.md)):

| Prefix     | Use for                                | Queue (Mergify) |
| ---------- | -------------------------------------- | --------------- |
| `fix/`     | bug fix                                | `queue:bug`     |
| `feat/`    | new feature, behaviour change          | `queue:feature` |
| `chore/`   | tooling, CI, deps, config, docs-only   | `queue:infra`   |
| `design/`  | CSS, Storybook stories, visual tweaks  | `queue:design`  |
| `plan/`    | plan PRs (scrum-master-pipeline)        | `queue:plan`    |
| `docs/`    | doc-only changes that don't queue      | (none)          |

The `branch-ticket-check.sh` pre-push hook enforces this — a branch that doesn't match one of the prefixes is rejected.

## Commit messages

Conventional-Commits style, one logical change per commit:

```
<type>(<scope>): <subject>

<body — wrap at 72 cols; explain the WHY, not the WHAT>

Co-Authored-By: ...
```

Types: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `perf`, `ci`, `revert`.

Squash-merge into `main` is the convention — commit history is preserved through your PR's commits but `main` gets one squashed commit per PR.

## Tests

Every PR needs the tests to be green. The CI workflow runs:

- `npx vitest run` at repo root (currently 201/201)
- `cd mcp/mergify && npx vitest run` (currently 87/87)

If you're adding a feature, **add a test that fails without your change.** If you're fixing a bug, **add a regression test that asserts the fix.** PRs that change behaviour without exercising the new behaviour in tests will be asked to add coverage before merge.

Run tests locally before pushing:

```bash
npx vitest run                                 # top-level
cd mcp/mergify && npx vitest run               # MCP server
cd mcp/mergify && npm run build                # MCP server build
```

## Code style

- **TypeScript / JavaScript:** match the surrounding file. The MCP server is ESM, strict TypeScript; tests are vitest. No prettier config — small, sensible diffs.
- **Bash:** `#!/usr/bin/env bash` + `set -euo pipefail` at the top of every script. Quote variables (`"$VAR"`, not `$VAR`). Use `[[ ]]` for tests in bash-only scripts, `[ ]` only when POSIX `sh` compatibility is intended.
- **Markdown:** prose-style headings (Title Case for §, sentence case for sub-headings is fine). One sentence per line is welcome.

## What lives where

- `SKILL.md` — skill contract; the user-facing entry point.
- `references/architecture.md` — authoritative spec for the 5 queues, 6 MCP tools, label-trust boundary, etc.
- `references/kanban-states.md` — the 12-state machine.
- `references/recovery-runbooks.md` — incident runbooks.
- `mcp/mergify/` — Mergify MCP server (TypeScript / stdio).
- `scripts/` — install/uninstall/doctor + per-plan helper scripts.
- `templates/` — files copied into a downstream by `scripts/install.sh`.
- `tests/` — skill-side tests (vitest).
- `.github/` — CI workflows, Dependabot config, CODEOWNERS.

## What NOT to do

- Don't commit secrets. The pre-commit hook scans for token prefixes (`gh[psroue]_`, `github_pat_`, `mrg_live_`, `mrg_test_`); if it blocks your commit, fix the leak rather than `--no-verify`-ing past it.
- Don't change `.mergify.yml.tmpl` queue names or label conventions without updating [`references/architecture.md`](references/architecture.md) §5 in the same PR — silent doc drift is a defect.
- Don't add `xfail` / `skip` to tests without a link to a follow-up issue in the comment above.
- Don't loosen `permissions: contents: read` on `.github/workflows/test.yml` without an explicit reason in the PR description.
- Don't unpin a GitHub Action from its SHA to a floating tag — Dependabot keeps the SHAs current.

## Review

Pull requests are reviewed by [@thomasbillings](https://github.com/thomasbillings) (CODEOWNERS auto-assigns review on PRs touching sensitive paths). The PR review uses the canonical structured format (defined in [`templates/agents/pr-reviewer.md`](templates/agents/pr-reviewer.md)):

```markdown
**Blockers (N)**
- [b1] ...

**Should-fix (M)**
- [s1] ...

**Nits (K)**
- [n1] ...
```

Blockers are mandatory before merge. Should-fix items can be deferred to a follow-up PR with mutual consent. Nits are author's choice.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE) (same as the project).
