/**
 * extract_ticket_from_plan helper (lib.sh).
 *
 * Used by dispatch.sh to build `feat/<TICKET>-<slug>` branch names when a
 * plan declares `ticket:` in its YAML frontmatter — so the resulting branch
 * satisfies jak-pipeline's branch-ticket-check.sh regex.
 *
 * Regression cases (#45):
 * - Unquoted ticket: `ticket: S20-4` → "S20-4"
 * - Quoted ticket: `ticket: "BAR-99"` → "BAR-99"
 * - Single-quoted ticket: `ticket: 'BAZ-1'` → "BAZ-1"
 * - No ticket field → empty string
 * - File doesn't exist → empty string
 * - `ticket:` only in body (after frontmatter close) → ignored
 * - Trailing whitespace → trimmed
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const LIB = resolve(REPO_ROOT, 'scripts/scrum-master/lib.sh');

function callHelper(planContent: string | null): { stdout: string; status: number } {
  let planPath = '/nonexistent/file';
  if (planContent !== null) {
    const dir = mkdtempSync(join(tmpdir(), 'ticket-test-'));
    planPath = join(dir, 'plan.md');
    writeFileSync(planPath, planContent);
    tmpDirs.push(dir);
  }
  const result = spawnSync('bash', ['-c', `. "${LIB}" && extract_ticket_from_plan "${planPath}"`], {
    encoding: 'utf-8',
  });
  return {
    stdout: (result.stdout ?? '').replace(/\n$/, ''),
    status: result.status ?? 1,
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('extract_ticket_from_plan (lib.sh) — #45', () => {
  it('returns unquoted ticket', () => {
    expect(callHelper('---\nschema_version: 1\nticket: S20-4\n---\nbody\n').stdout).toBe('S20-4');
  });

  it('returns double-quoted ticket (strips quotes)', () => {
    expect(callHelper('---\nticket: "BAR-99"\n---\n').stdout).toBe('BAR-99');
  });

  it("returns single-quoted ticket (strips quotes)", () => {
    expect(callHelper("---\nticket: 'BAZ-1'\n---\n").stdout).toBe('BAZ-1');
  });

  it('returns empty when ticket: absent from frontmatter', () => {
    expect(callHelper('---\nschema_version: 1\npriority: high\n---\nbody\n').stdout).toBe('');
  });

  it('returns empty when plan file does not exist', () => {
    expect(callHelper(null).stdout).toBe('');
  });

  it('ignores "ticket:" appearing only in body (after frontmatter close)', () => {
    expect(callHelper('---\nschema_version: 1\n---\n\nticket: BODY-1 (not real)\n').stdout).toBe('');
  });

  it('trims trailing whitespace from ticket value', () => {
    expect(callHelper('---\nticket: S20-7   \n---\n').stdout).toBe('S20-7');
  });

  it('returns first ticket if frontmatter (somehow) has multiple', () => {
    expect(callHelper('---\nticket: FIRST-1\nticket: SECOND-2\n---\n').stdout).toBe('FIRST-1');
  });
});
