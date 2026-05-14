/**
 * Issue #63: check-plan.sh must validate the optional `ticket:` field
 * format when present.
 *
 * Plan authors who set `ticket: not-a-real-ticket` would otherwise produce
 * branch names like `feat/not-a-real-ticket-add-foo` which fail the
 * branch-ticket-check.sh pre-push hook with no clear cause. Validating at
 * plan-review time stops the bad value from reaching dispatch.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CHECK_PLAN = path.join(SKILL_ROOT, 'scripts', 'scrum-master', 'check-plan.sh');

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function writePlan(frontmatter: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-plan-ticket-'));
  tmpDirs.push(dir);
  const planFile = path.join(dir, '2026-05-14-test-slug.md');
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${v}`);
  lines.push('---', '', '# test plan', '', 'acceptance_criteria:', '  - thing happens', '');
  fs.writeFileSync(planFile, lines.join('\n'));
  return planFile;
}

function runCheckPlan(planFile: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [CHECK_PLAN, planFile], { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('check-plan.sh — ticket: format validation (issue #63)', () => {
  const baseFrontmatter = {
    schema_version: '1',
    title: 'test plan',
    type: 'feature',
    status: 'draft',
    priority: 'medium',
    created: '2026-05-14',
  };

  it('absent ticket: field — no finding (field is optional)', () => {
    const plan = writePlan(baseFrontmatter);
    const r = runCheckPlan(plan);
    expect(r.stdout + r.stderr).not.toMatch(/ticket_format_invalid/);
  });

  it('valid ticket: field (SCRUM-1) — no finding', () => {
    const plan = writePlan({ ...baseFrontmatter, ticket: 'SCRUM-1' });
    const r = runCheckPlan(plan);
    expect(r.stdout + r.stderr).not.toMatch(/ticket_format_invalid/);
  });

  it('valid ticket: field with digit in project key (S20-4) — no finding', () => {
    // Atlassian-compliant: project keys can have digits after the leading
    // letter. Issue #67 tightened the regex to ACCEPT this (the previous
    // tick-extension.sh BRANCH_RE rejected it, creating a silent skew with
    // check-plan).
    const plan = writePlan({ ...baseFrontmatter, ticket: 'S20-4' });
    const r = runCheckPlan(plan);
    expect(r.stdout + r.stderr).not.toMatch(/ticket_format_invalid/);
  });

  it('invalid: underscore in project key (FOO_BAR-12) — surfaces ticket_format_invalid', () => {
    // Atlassian project keys do NOT allow underscores. Per issue #67, the
    // check-plan regex was tightened to reject this — previously permitted.
    const plan = writePlan({ ...baseFrontmatter, ticket: 'FOO_BAR-12' });
    const r = runCheckPlan(plan);
    expect(r.stdout + r.stderr).toMatch(/ticket_format_invalid/);
  });

  it('invalid: lowercase project key (scrum-1) — surfaces ticket_format_invalid', () => {
    const plan = writePlan({ ...baseFrontmatter, ticket: 'scrum-1' });
    const r = runCheckPlan(plan);
    expect(r.stdout + r.stderr).toMatch(/ticket_format_invalid/);
  });

  it('invalid: no dash separator (SCRUM1) — surfaces ticket_format_invalid', () => {
    const plan = writePlan({ ...baseFrontmatter, ticket: 'SCRUM1' });
    const r = runCheckPlan(plan);
    expect(r.stdout + r.stderr).toMatch(/ticket_format_invalid/);
  });

  it('invalid: non-numeric ticket number (SCRUM-abc) — surfaces ticket_format_invalid', () => {
    const plan = writePlan({ ...baseFrontmatter, ticket: 'SCRUM-abc' });
    const r = runCheckPlan(plan);
    expect(r.stdout + r.stderr).toMatch(/ticket_format_invalid/);
  });

  it('invalid: contains slashes (not-a-real-ticket) — surfaces ticket_format_invalid', () => {
    const plan = writePlan({ ...baseFrontmatter, ticket: 'not-a-real-ticket' });
    const r = runCheckPlan(plan);
    expect(r.stdout + r.stderr).toMatch(/ticket_format_invalid/);
  });

  it('quoted ticket value ("SCRUM-1") — no finding (get_scalar strips quotes)', () => {
    const plan = writePlan({ ...baseFrontmatter, ticket: '"SCRUM-1"' });
    const r = runCheckPlan(plan);
    expect(r.stdout + r.stderr).not.toMatch(/ticket_format_invalid/);
  });
});
