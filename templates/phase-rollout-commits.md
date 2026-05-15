# Phase Rollout Cookbook

Phased activation of the jak-pipeline Mergify queues. Each section corresponds
to a phase in `references/architecture.md §11`.

## How to apply a phase

The day-0 `.mergify.yml.tmpl` ships with `queue_rules: []` and all five queue
blocks as comments below. Phase rollout = uncomment one block and move it
into `queue_rules`. Always one queue per commit.

For each phase:

1. Open `.mergify.yml` in the downstream project.
2. Find the `# Queue: <name>` block in the commented section near the bottom.
3. Uncomment every line of that block (strip the leading `# ` from each line,
   leaving `# Queue: <name>` itself as a comment if you like — only the YAML
   lines need to be uncommented).
4. Move the uncommented block into the `queue_rules:` list at the top of the
   file. If `queue_rules:` is currently `queue_rules: []`, replace the `[]`
   with a YAML list:

   ```yaml
   queue_rules:
     - name: <name>
       merge_method: squash
       update_method: rebase
       batch_size: 1
       queue_conditions:
         - ...
       merge_conditions:
         - ...
   ```

   If `queue_rules:` already has entries, append the new block as another
   list item below the existing ones.
5. Commit with the message in the relevant section below.
6. Verify Mergify accepts the new config:

   ```bash
   curl -H "Authorization: bearer $MERGIFY_API_KEY" \
        https://api.mergify.com/v1/repos/<org>/<repo>/queues
   ```

   Should return 2xx. A 400 with `Extra inputs are not permitted` means a
   field slipped through that isn't valid in Mergify v1 — most likely
   `disabled`, `priority`, `speculative_checks`, or `allow_inplace_checks`.

Rollback for any phase: `git revert <enable-commit>`. The commented block
will reappear in the file and the active queue entry will be removed.

**Day 6-13 enable order:** `queue:bug` first, then `queue:feature`, then
`queue:design`. See architecture §11 for the rationale (bug=highest priority
+ longest observation window; feature=highest volume; design=lowest risk).

---

## Day 1-2: Enable `queue:plan`

Plan PRs now route through Mergify. Everything else still uses the legacy
`auto-update-prs.yml` workflow.

The active queue entry to add:

```yaml
  - name: plan
    merge_method: squash
    update_method: rebase
    batch_size: 1
    queue_conditions:
      - "head~=^plan/"
      - "label=queue:plan"
      - "check-success-or-neutral=lint"
      - "check-success-or-neutral=check-plan"
    merge_conditions:
      - "check-success-or-neutral=lint"
      - "check-success-or-neutral=check-plan"
```

The commented block to delete (below the active `queue_rules:` list):

```diff
-# Queue: plan — plan/* branches; lint + check-plan.sh only
-# - name: plan
-#   merge_method: squash
-#   update_method: rebase
-#   batch_size: 1
-#   queue_conditions:
-#     - "head~=^plan/"
-#     - "label=queue:plan"
-#     - "check-success-or-neutral=lint"
-#     - "check-success-or-neutral=check-plan"
-#   merge_conditions:
-#     - "check-success-or-neutral=lint"
-#     - "check-success-or-neutral=check-plan"
```

Commit message: `feat(mergify): enable queue:plan (Day 1-2)`

---

## Day 3-5: Enable `queue:infra`

Chore/infra PRs join the Mergify queue. Plan queue continues running.

Active entry:

```yaml
  - name: infra
    merge_method: squash
    update_method: rebase
    batch_size: 1
    queue_conditions:
      - "head~=^chore/"
      - "label=queue:infra"
      - "check-success-or-neutral=lint"
      - "check-success-or-neutral=test"
    merge_conditions:
      - "check-success-or-neutral=lint"
      - "check-success-or-neutral=test"
```

Delete the matching commented block:

```diff
-# Queue: infra — chore/* branches; lint + unit (no e2e)
-# - name: infra
-#   ...
```

Commit message: `feat(mergify): enable queue:infra (Day 3-5)`

---

## Day 6-13: Enable remaining queues (`queue:bug`, `queue:feature`, `queue:design`)

Full cutover for code PRs. Apply three commits in order, with a ~60-second
pause between each to confirm the previous queue's first PR drained cleanly.

### Step 1: Enable `queue:bug` (highest priority, longest observation window)

Active entry:

```yaml
  - name: bug
    merge_method: squash
    update_method: rebase
    batch_size: 1
    queue_conditions:
      - "head~=^fix/"
      - "label=queue:bug"
      - "check-success-or-neutral=lint"
      - "check-success-or-neutral=typecheck"
      - "check-success-or-neutral=test"
      - "check-success-or-neutral=build"
    merge_conditions:
      - "check-success-or-neutral=lint"
      - "check-success-or-neutral=typecheck"
      - "check-success-or-neutral=test"
      - "check-success-or-neutral=build"
```

Delete the matching commented block:

```diff
-# Queue: bug — fix/* branches; full CI gate
-# - name: bug
-#   ...
```

Commit message: `feat(mergify): enable queue:bug (Day 6-13 step 1)`

### Step 2: Enable `queue:feature` (highest volume lane)

Active entry:

```yaml
  - name: feature
    merge_method: squash
    update_method: rebase
    batch_size: 1
    queue_conditions:
      - "head~=^feat/"
      - "label=queue:feature"
      - "check-success-or-neutral=lint"
      - "check-success-or-neutral=typecheck"
      - "check-success-or-neutral=test"
      - "check-success-or-neutral=build"
    merge_conditions:
      - "check-success-or-neutral=lint"
      - "check-success-or-neutral=typecheck"
      - "check-success-or-neutral=test"
      - "check-success-or-neutral=build"
```

Delete the matching commented block:

```diff
-# Queue: feature — feat/* branches; full CI gate
-# - name: feature
-#   ...
```

Commit message: `feat(mergify): enable queue:feature (Day 6-13 step 2)`

### Step 3: Enable `queue:design` (lowest risk, last in)

Active entry:

```yaml
  - name: design
    merge_method: squash
    update_method: rebase
    batch_size: 1
    queue_conditions:
      - "head~=^design/"
      - "label=queue:design"
      - "check-success-or-neutral=lint"
      - "check-success-or-neutral=test"
    merge_conditions:
      - "check-success-or-neutral=lint"
      - "check-success-or-neutral=test"
```

Delete the matching commented block:

```diff
-# Queue: design — design/* branches; CSS/copy fast lane (lint + unit)
-# - name: design
-#   ...
```

Commit message: `feat(mergify): enable queue:design (Day 6-13 step 3)`

---

## Day 14+: Retire `auto-update-prs.yml`

After two green weeks on the full Mergify queue, delete the legacy
auto-update-prs workflow. Mergify's `update_method: rebase` handles the
BEHIND-cascade that this workflow previously managed.

Apply with the guard below (safe on projects that have already deleted the file):

```bash
[ -f .github/workflows/auto-update-prs.yml ] \
  && git rm .github/workflows/auto-update-prs.yml \
  || echo "already absent — no-op"
```

Commit message: `chore: retire auto-update-prs.yml (Mergify Day 14+)`

**Note:** TnT Finance already deleted `auto-update-prs.yml` in PR #253.
The guard ensures this step is a no-op on that project.
