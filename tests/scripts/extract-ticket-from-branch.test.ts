/**
 * lib.sh:extract_ticket_from_branch — extracts the Jira ticket key from a
 * branch name of the form `<prefix>/<TICKET>-<slug>`. Used by the dev-agent
 * to prefix PR titles with the ticket for human discoverability.
 *
 * Regex must stay aligned with tick-extension.sh's BRANCH_RE so the dev-
 * agent's PR title and the drift reconciliation pass extract the same key.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const LIB = path.join(SKILL_ROOT, 'scripts', 'scrum-master', 'lib.sh');

function extract(branch: string): string {
  const r = spawnSync('bash', ['-c', `. "${LIB}" && extract_ticket_from_branch "${branch}"`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`extract_ticket_from_branch exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

describe('lib.sh:extract_ticket_from_branch', () => {
  it('extracts SCRUM-1 from feat/SCRUM-1-add-foo', () => {
    expect(extract('feat/SCRUM-1-add-foo')).toBe('SCRUM-1');
  });

  it('extracts SCRUM-42 from chore/SCRUM-42-bump-deps', () => {
    expect(extract('chore/SCRUM-42-bump-deps')).toBe('SCRUM-42');
  });

  it('extracts GH-7 from plan/GH-7-something', () => {
    expect(extract('plan/GH-7-something')).toBe('GH-7');
  });

  it('handles each branch-ticket-check.sh-recognised prefix (plan|feat|fix|chore|design|docs|test)', () => {
    expect(extract('plan/PROJ-1-x')).toBe('PROJ-1');
    expect(extract('feat/PROJ-2-x')).toBe('PROJ-2');
    expect(extract('fix/PROJ-3-x')).toBe('PROJ-3');
    expect(extract('chore/PROJ-4-x')).toBe('PROJ-4');
    expect(extract('design/PROJ-5-x')).toBe('PROJ-5');
    expect(extract('docs/PROJ-6-x')).toBe('PROJ-6');
    expect(extract('test/PROJ-7-x')).toBe('PROJ-7');
  });

  it('returns empty for a branch without a ticket (legacy feat/<slug>)', () => {
    expect(extract('feat/no-ticket-here')).toBe('');
  });

  it('returns empty for the bare main branch', () => {
    expect(extract('main')).toBe('');
  });

  it('returns empty for an unrecognised prefix', () => {
    expect(extract('release/SCRUM-1-x')).toBe('');
  });

  it('returns empty when the branch is empty string', () => {
    expect(extract('')).toBe('');
  });

  it('returns empty when the ticket part is malformed (lowercase project key)', () => {
    // Project keys start with an uppercase letter; lowercase keys fail.
    expect(extract('feat/scrum-1-foo')).toBe('');
  });

  // Issue #67 — project key shape aligned across check-plan, tick-extension,
  // and lib.sh. Project keys with DIGITS after the leading letter (e.g.,
  // S20) are Atlassian-compliant and must be extracted.
  it('extracts S20-4 from feat/S20-4-add-foo (digit in project key — issue #67)', () => {
    expect(extract('feat/S20-4-add-foo')).toBe('S20-4');
  });

  it('extracts E2-123 from chore/E2-123-x (digits-only suffix in project key)', () => {
    expect(extract('chore/E2-123-x')).toBe('E2-123');
  });

  // Issue #67 — project keys with UNDERSCORES are NOT Atlassian-compliant
  // and must be rejected (the old too-permissive check-plan regex allowed
  // them).
  it('returns empty for underscore in project key (FOO_BAR-12 — issue #67)', () => {
    expect(extract('feat/FOO_BAR-12-baz')).toBe('');
  });
});
