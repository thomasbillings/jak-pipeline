import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DECIDER = resolve(REPO_ROOT, 'scripts/label-gate-decide.sh');
const LOG_APPENDER = resolve(REPO_ROOT, 'scripts/label-log-append.sh');
const FIXTURES_BIN = resolve(__dirname, '../_fixtures/bin');

let tmpDir: string;

beforeEach(() => {
  tmpDir = os.tmpdir() + '/jak-trust-test-' + Date.now();
  mkdirSync(tmpDir + '/agents', { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runDecider(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [DECIDER, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${FIXTURES_BIN}:${process.env.PATH}`,
      GH_STUB_MODE: 'reviews-approved-no-blockers',
      GH_CHECKS_MODE: 'green',
      GITHUB_REVIEWER_LOGIN: 'github-actions[bot]',
      GITHUB_OWNER: 'testowner',
      GITHUB_REPO: 'testrepo',
      JAK_PROJECT_ROOT: tmpDir,
      ...env,
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runAppender(
  args: string[],
  env: Record<string, string> = {},
): { status: number } {
  const result = spawnSync('bash', [LOG_APPENDER, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      JAK_PROJECT_ROOT: tmpDir,
      ...env,
    },
  });
  return { status: result.status ?? 1 };
}

describe('label trust boundary', () => {
  it("pr-reviewer cannot apply queue:plan", () => {
    // Regardless of CI state, queue:plan is user-only
    const r = runDecider(['pr-reviewer', '42', 'queue:plan'], {
      GH_STUB_MODE: 'reviews-approved-no-blockers',
      GH_CHECKS_MODE: 'green',
    });
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe('refuse');
  });

  it("pr-reviewer cannot apply when own BLOCKERs > 0", () => {
    // Fixture review has BLOCKERS: 1
    const r = runDecider(['pr-reviewer', '42', 'queue:feature'], {
      GH_STUB_MODE: 'reviews-approved-has-blockers',
    });
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe('refuse');
  });

  it("pr-reviewer cannot apply when CI is failing", () => {
    // Required check has failure status
    const r = runDecider(['pr-reviewer', '42', 'queue:feature'], {
      GH_STUB_MODE: 'reviews-approved-no-blockers',
      GH_CHECKS_MODE: 'failing',
    });
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe('refuse');
  });

  it("decider reads gh api reviews, never PR body", () => {
    // Structural assertion: grep for bare /pulls/<n> without /reviews or /check-runs
    const { stdout } = spawnSync(
      'grep',
      ['-E', "gh api .*/pulls/[0-9]+[^/']", DECIDER],
      { encoding: 'utf-8' },
    );
    // No such call should exist in the script
    expect(stdout.trim()).toBe('');
  });

  it("log writer appends row with all required fields", () => {
    const r = runAppender([
      'pr-reviewer',
      '42',
      'queue:feature',
      '0',
      'green',
      'all checks passed',
    ]);
    expect(r.status).toBe(0);

    const logPath = tmpDir + '/agents/_label-log.jsonl';
    expect(existsSync(logPath)).toBe(true);

    const row = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(row.applied_by).toBeTruthy();
    expect(row.pr_number).toBeTruthy();
    expect(row.label).toBeTruthy();
    expect(typeof row.blocker_count).toBe('number');
    expect(row.tests_state).toBeTruthy();
    expect(row.reasoning).toBeTruthy();
    expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});
