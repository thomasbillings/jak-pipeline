---
schema_version: 1
title: "TITLE HERE"
type: feature           # feature | fix | infra | chore
status: draft
priority: medium        # low | medium | high
ticket: SCRUM-0         # optional but recommended; when present, dispatch.sh
                        # names the dev-agent's branch feat/<TICKET>-<slug>
                        # so it satisfies the branch-ticket-check pre-push
                        # hook. Format: <PROJECT-KEY>-<N>. Drop the line
                        # entirely (or leave the placeholder) to fall back
                        # to feat/<slug>.
depends_on: []          # list of other plan slugs (no date prefix) that must be done first
parallel_safe: true
owner: planner
created: YYYY-MM-DD
acceptance_criteria:
  - a1: Specific, measurable, testable.
  - a2: Next criterion.
e2e_tests:
  - path: tests/e2e/<file>.spec.ts
    covers: [a1]
  - path: tests/unit/<file>.test.ts
    covers: [a2]
manual_verification:    # optional; for infra/chore plans
  - m1: Step that can't be automated.
---

# <Title>

## 1. Problem statement

<2–5 sentences on why this plan exists.>

## 2. Proposed solution

<High-level approach. What changes, at what layer.>

## 3. Data model changes

<None, or Drizzle schema additions + migration strategy.>

## 4. API surface

<None, or new/modified routes, server actions, permissions required.>

## 5. UI changes

<None, or which routes/components. Confirm Storybook coverage for any component proposed.>

## 6. Test coverage

<Map each acceptance criterion to a concrete test file + test name.>

## 7. Risks

<Named risks with 1-line mitigations.>

## 8. Out of scope

<What this plan is NOT doing.>

## 9. Implementation sequencing

1. <Step 1 — failing test>
2. <Step 2 — impl>
3. <Step 3 — refactor>
4. <Step 4 — e2e + browser-verify>
5. <Step 5 — open PR>

## 10. Open questions

<Anything ambiguous in the brief.>
