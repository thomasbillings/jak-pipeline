import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/branch-ticket-check.sh');

function run(branch: string): { status: number; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, branch], {
    encoding: 'utf-8',
  });
  return {
    status: result.status ?? 1,
    stderr: result.stderr ?? '',
  };
}

describe('scripts/branch-ticket-check.sh (a7)', () => {
  it('exits 0 on valid branch: feat/SCRUM-123-add-foo', () => {
    expect(run('feat/SCRUM-123-add-foo').status).toBe(0);
  });

  it('exits 0 on valid branch: fix/GH-99-bug', () => {
    expect(run('fix/GH-99-bug').status).toBe(0);
  });

  it('exits 0 on valid branch: plan/SCRUM-1-x', () => {
    expect(run('plan/SCRUM-1-x').status).toBe(0);
  });

  it('exits 0 on valid branch: chore/GH-2-y', () => {
    expect(run('chore/GH-2-y').status).toBe(0);
  });

  it('exits 0 on valid branch: design/SCRUM-3-z', () => {
    expect(run('design/SCRUM-3-z').status).toBe(0);
  });

  it('exits 0 on valid branch: docs/GH-4-a', () => {
    expect(run('docs/GH-4-a').status).toBe(0);
  });

  it('exits 0 on valid branch: test/SCRUM-5-b', () => {
    expect(run('test/SCRUM-5-b').status).toBe(0);
  });
});

describe('scripts/branch-ticket-check.sh (a9) — reject cases', () => {
  it('exits 1 on wrong prefix: feature/SCRUM-1-x', () => {
    const r = run('feature/SCRUM-1-x');
    expect(r.status).toBe(1);
    expect(r.stderr).toBeTruthy();
  });

  it('exits 1 on wrong key namespace: feat/JIRA-1-x', () => {
    const r = run('feat/JIRA-1-x');
    expect(r.status).toBe(1);
  });

  it('exits 1 on non-numeric ticket id: feat/SCRUM-x-y', () => {
    const r = run('feat/SCRUM-x-y');
    expect(r.status).toBe(1);
  });

  it('exits 1 on uppercase slug: feat/SCRUM-1-X', () => {
    const r = run('feat/SCRUM-1-X');
    expect(r.status).toBe(1);
  });

  it('exits 1 on missing slug: feat/SCRUM-1', () => {
    const r = run('feat/SCRUM-1');
    expect(r.status).toBe(1);
  });

  it('exits 1 on bare: main', () => {
    const r = run('main');
    expect(r.status).toBe(1);
  });

  it('exits 1 on empty string', () => {
    const r = run('');
    expect(r.status).toBe(1);
  });

  it('stderr message names the offending branch', () => {
    const r = run('feature/SCRUM-1-x');
    expect(r.stderr).toContain('feature/SCRUM-1-x');
  });
});
