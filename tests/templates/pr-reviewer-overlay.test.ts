import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const OVERLAY_PATH = resolve(REPO_ROOT, 'templates/agents/pr-reviewer-label-gate.md');

describe('templates/agents/pr-reviewer-label-gate.md', () => {
  it('file exists', () => {
    expect(existsSync(OVERLAY_PATH)).toBe(true);
  });

  it('declares labels pr-reviewer MAY apply (queue:bug, queue:feature, queue:infra, queue:design)', () => {
    const content = readFileSync(OVERLAY_PATH, 'utf-8');
    expect(content).toContain('queue:bug');
    expect(content).toContain('queue:feature');
    expect(content).toContain('queue:infra');
    expect(content).toContain('queue:design');
  });

  it('declares queue:plan is user-only (pr-reviewer MUST NEVER apply it)', () => {
    const content = readFileSync(OVERLAY_PATH, 'utf-8');
    expect(content).toContain('queue:plan');
    // Should say something like "never", "must not", "user-only"
    expect(content).toMatch(/never|must not|user.only|NEVER/i);
  });

  it('describes three-condition gate: own BLOCKERs=0, CI checks green, reads from gh api reviews', () => {
    const content = readFileSync(OVERLAY_PATH, 'utf-8');
    expect(content).toMatch(/BLOCKERS?\s*=\s*0|blocker.count.*0|BLOCKERs.*zero/i);
    expect(content).toMatch(/CI.*green|checks.*green|tests.*green|green.*CI/i);
    expect(content).toMatch(/gh api|github api/i);
  });

  it('invokes label-gate-decide.sh for the apply/refuse decision', () => {
    const content = readFileSync(OVERLAY_PATH, 'utf-8');
    expect(content).toContain('label-gate-decide.sh');
  });

  it('contains sentinel comment for idempotent re-append', () => {
    const content = readFileSync(OVERLAY_PATH, 'utf-8');
    expect(content).toContain('<!-- jak-pipeline:pr-reviewer-label-gate v1 -->');
  });

  it('includes example invocation of label-gate-decide.sh', () => {
    const content = readFileSync(OVERLAY_PATH, 'utf-8');
    // Should show how to call it: label-gate-decide.sh <role> <pr_number> <intended_label>
    expect(content).toMatch(/label-gate-decide\.sh.*role|label-gate-decide\.sh.*pr/i);
  });
});
