import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/label-gate-decide.sh');
const FIXTURES_BIN = resolve(__dirname, '../_fixtures/bin');

function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${FIXTURES_BIN}:${process.env.PATH}`,
      GH_STUB_MODE: 'reviews-approved-no-blockers',
      GITHUB_REVIEWER_LOGIN: 'github-actions[bot]',
      GITHUB_OWNER: 'testowner',
      GITHUB_REPO: 'testrepo',
      ...env,
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('scripts/label-gate-decide.sh', () => {
  it('(i) refuses with exit 2 if role is not pr-reviewer', () => {
    const r = run(['scrum-master', '42', 'queue:feature']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/role-not-authorised|role_not_authorised/);
  });

  it('(ii) refuses with exit 2 if intended_label is queue:plan (user-only)', () => {
    const r = run(['pr-reviewer', '42', 'queue:plan']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/refuse/);
  });

  it('(iii) refuses with exit 2 if intended_label is not in allowed set', () => {
    const r = run(['pr-reviewer', '42', 'queue:unknown']);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/refuse/);
  });

  it('(iv) refuses when own review has BLOCKERS > 0', () => {
    const r = run(['pr-reviewer', '42', 'queue:feature'], {
      GH_STUB_MODE: 'reviews-approved-has-blockers',
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/refuse/);
  });

  it('(iv) refuses when no matching review exists', () => {
    const r = run(['pr-reviewer', '42', 'queue:feature'], {
      GH_STUB_MODE: 'reviews-empty',
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/refuse/);
  });

  it('(v) refuses when required CI check is failing', () => {
    const r = run(['pr-reviewer', '42', 'queue:feature'], {
      GH_STUB_MODE: 'reviews-approved-no-blockers',
      GH_CHECKS_MODE: 'failing',
    });
    // The gh stub needs to handle checks — we'll make the gh shim check GH_CHECKS_MODE
    // For the red phase this will fail on missing script
    expect(r.status).toBe(2);
  });

  it('(vi) exits 0 with apply decision when all conditions met', () => {
    const r = run(['pr-reviewer', '42', 'queue:feature'], {
      GH_STUB_MODE: 'reviews-approved-no-blockers',
      GH_CHECKS_MODE: 'green',
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe('apply');
    expect(out.label).toBe('queue:feature');
    expect(out.blocker_count).toBe(0);
    expect(out.tests_state).toBe('green');
    expect(out.reasoning).toBeTruthy();
  });

  it('accepts all four allowed labels', () => {
    for (const label of ['queue:bug', 'queue:feature', 'queue:infra', 'queue:design']) {
      const r = run(['pr-reviewer', '42', label], {
        GH_STUB_MODE: 'reviews-approved-no-blockers',
        GH_CHECKS_MODE: 'green',
      });
      expect(r.status, `should accept ${label}`).toBe(0);
    }
  });

  it('script never calls bare /pulls/<n> endpoint (injection guard)', () => {
    // Structural assertion: grep for gh api calls without /reviews or /check-runs suffix
    const { stdout } = spawnSync(
      'grep',
      ['-E', "gh api .*/pulls/[0-9]+[^/']", SCRIPT],
      { encoding: 'utf-8' },
    );
    // Should return no hit (only /pulls/<n>/reviews or /pulls/<n>/check-runs are acceptable)
    expect(stdout.trim()).toBe('');
  });
});
