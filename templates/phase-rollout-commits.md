# Phase Rollout Cookbook

Phased activation of the jak-pipeline Mergify queues. Each section corresponds
to a phase in `references/architecture.md §11`.

Apply a diff to the downstream project's `.mergify.yml`:

```bash
git apply phase-N.patch
git commit -m "feat(mergify): enable queue:X (Day N)"
```

Or copy the diff block to a `.patch` file and run `git apply <file>`.

`git apply` uses context matching, so diffs generated against the Day-0 baseline
still apply cleanly after earlier phases have been activated (the surrounding
context lines — queue name, priority — remain unique).

**Day 6-13 enable order:** `queue:bug` first, then `queue:feature`, then
`queue:design`. See architecture §11 for the rationale (bug=highest priority
+ longest observation window; feature=highest volume; design=lowest risk).

---

## Day 1-2: Enable `queue:plan`

Plan PRs now route through Mergify. Everything else still uses the legacy
`auto-update-prs.yml` workflow.

```diff
--- a/.mergify.yml
+++ b/.mergify.yml
@@ -38,7 +38,6 @@ queue_rules:
 
   # Priority 3 — plan PRs; lint + check-plan.sh only
   - name: plan
-    disabled: true
     priority: 3
     merge_method: squash
     update_method: rebase
```

Commit message: `feat(mergify): enable queue:plan (Day 1-2)`

---

## Day 3-5: Enable `queue:infra`

Chore/infra PRs join the Mergify queue. Plan queue continues running.

```diff
--- a/.mergify.yml
+++ b/.mergify.yml
@@ -78,7 +78,6 @@ queue_rules:
 
   # Priority 1 — infra/chore PRs; lint + unit only (no e2e)
   - name: infra
-    disabled: true
     priority: 1
     merge_method: squash
     update_method: rebase
```

Commit message: `feat(mergify): enable queue:infra (Day 3-5)`

---

## Day 6-13: Enable remaining queues (`queue:bug`, `queue:feature`, `queue:design`)

Full cutover for code PRs. Apply three commits in order, with a ~60-second
pause between each to confirm the previous queue's first PR drained cleanly.

### Step 1: Enable `queue:bug` (highest priority, longest observation window)

```diff
--- a/.mergify.yml
+++ b/.mergify.yml
@@ -16,7 +16,6 @@
 queue_rules:
   # Priority 4 (highest) — bug fixes; full CI gate
   - name: bug
-    disabled: true
     priority: 4
     merge_method: squash
     update_method: rebase
```

Commit message: `feat(mergify): enable queue:bug (Day 6-13 step 1)`

### Step 2: Enable `queue:feature` (highest volume lane)

```diff
--- a/.mergify.yml
+++ b/.mergify.yml
@@ -56,7 +56,6 @@ queue_rules:
 
   # Priority 2 — feature PRs; full CI gate
   - name: feature
-    disabled: true
     priority: 2
     merge_method: squash
     update_method: rebase
```

Commit message: `feat(mergify): enable queue:feature (Day 6-13 step 2)`

### Step 3: Enable `queue:design` (lowest risk, last in)

```diff
--- a/.mergify.yml
+++ b/.mergify.yml
@@ -96,7 +96,6 @@ queue_rules:
 
   # Priority 0 (lowest) — design/CSS PRs; lint + unit fast lane (no UAT, no plan)
   - name: design
-    disabled: true
     priority: 0
     merge_method: squash
     update_method: rebase
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
