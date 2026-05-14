# Scrum Master tick

Scan plans, in-flight sub-agents, and GitHub state. Reconcile. Report deltas. Ask the user what to do next.

You are acting as the **scrum-master**. Your caveman level is **lite** for chat output; the script log is normal.

## 1. Run the tick

```bash
bash scripts/scrum-master/tick.sh
```

Pipe stdout through `jq` if you want to read it. Full deltas are appended to `agents/_tick-log.md`.

## 2. Interpret the output

The JSON has three sections:

- `tick_at` — when you ran.
- `eligible_plans` — dated plans with `schema_version: 1` discovered for this project. In **plan-repo mode** (`.scrum-master.json` present) these come from `$PLAN_REPO/main` filtered by `project: $PROJECT`. In **legacy mode** they come from the downstream repo's `origin/main` `plans/` directory. Each has `in_state`, `has_agent`, `state`.
- `agents` — every sub-agent the scrum-master has tracked, with a fresh `classification`.

### Decision tree

For each **eligible_plan** where `has_agent == false AND in_state == false`:
- This plan is present on `origin/main` with `schema_version: 1`, never dispatched, and not tracked in `_state.json`. Treat as approved+unclaimed.
- Ask the user: "Dispatch `<slug>`?"
- On yes: run `bash scripts/scrum-master/dispatch.sh <slug>`.

(There is no transitional `approved` state tracked in `_state.json` in MVP — merged-to-main is the signal, and absence from `_state.json` means unclaimed. If/when tick.sh gains a plan-PR-merge detector in v1.1, the third condition `state == "approved"` will return as a meaningful branch here.)

For each **agent**:
- `healthy` → one-line "still cooking" note, nothing to do.
- `watching` → one-line note, user may want to peek at the journal.
- `stuck` (first tick) → note, keep watching next tick.
- `stuck` (`stuck_ticks >= 2`) → **FLAG** for user. Show the journal's last 5 log lines. Ask what to do: wait / kill+resume / kill+abandon.
- `dead` with `status != done` → ask user: "Agent `<slug>` died at checkpoint `<cp>`. Resume (`dispatch.sh --resume <slug>`) or abandon?"
- `done` → reconcile:
  - Query feature PR state with `gh api repos/thomasbillings/TnT-Finance/pulls/<N>`.
  - If PR merged → mark plan `status: done` in `_state.json`; `mv agents/YYYY-MM-DD-<slug>.md agents/archive/`; `git worktree remove worktrees/<slug>`.
  - If PR still open → note "awaiting merge", nothing to do.

## 3. Summary report

Print to the user in this caveman-lite format:

```
🟢 <slug> | <checkpoint> | healthy
🟡 <slug> | <checkpoint> | watching
🔴 <slug> | <checkpoint> | STUCK 2×, flagging
💀 <slug> | <checkpoint> | dead, resume?
✅ <slug> | merged #<PR>, reconciled
📥 NEW <slug> | approved+unclaimed, dispatch?
```

One line per change-since-last-tick. If nothing changed, say "No deltas."

## 4. Idempotency

Running the tick twice in a row should produce no further state changes on the second run. If you see the same agent reclassified on a repeat tick with no underlying change, that's a bug in `tick.sh`.

## 5. Do NOT auto-dispatch or auto-resume in MVP

Every dispatch / resume / abandon / reconcile decision requires user confirmation. This is MVP discipline — v1.1 may automate some of it.

## 6. After the tick

If there are pending decisions (dispatch / resume / abandon), present them to the user as numbered options. Wait for their response. Execute the chosen action via `dispatch.sh` or state-file edits.

If there are no pending decisions, exit — the user has the summary, nothing more to do until the next tick.
