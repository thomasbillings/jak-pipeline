import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/label-log-append.sh');

let tmpDir: string;

beforeEach(() => {
  tmpDir = os.tmpdir() + '/jak-label-log-test-' + Date.now();
  mkdirSync(tmpDir + '/agents', { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
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

describe('scripts/label-log-append.sh', () => {
  it('appends row with all six required fields', () => {
    const r = run([
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

    const line = readFileSync(logPath, 'utf-8').trim();
    const row = JSON.parse(line);

    expect(row.applied_by).toBe('pr-reviewer');
    expect(row.pr_number).toBe(42);
    expect(row.label).toBe('queue:feature');
    expect(row.blocker_count).toBe(0);
    expect(row.tests_state).toBe('green');
    expect(row.reasoning).toBe('all checks passed');
    expect(row.applied_at).toBeTruthy();
    // applied_at should be ISO 8601
    expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('creates agents/ directory and file if missing', () => {
    rmSync(tmpDir + '/agents', { recursive: true, force: true });
    const r = run([
      'pr-reviewer',
      '99',
      'queue:bug',
      '0',
      'green',
      'test',
    ]);
    expect(r.status).toBe(0);
    expect(existsSync(tmpDir + '/agents/_label-log.jsonl')).toBe(true);
  });

  it('appends multiple rows (not overwrites)', () => {
    const now1 = '2026-01-01T10:00:30Z';
    const now2 = '2026-01-01T10:01:30Z';

    run(['pr-reviewer', '1', 'queue:bug', '0', 'green', 'first'], {
      JAK_NOW_OVERRIDE: now1,
    });
    run(['pr-reviewer', '2', 'queue:feature', '0', 'green', 'second'], {
      JAK_NOW_OVERRIDE: now2,
    });

    const lines = readFileSync(tmpDir + '/agents/_label-log.jsonl', 'utf-8')
      .trim()
      .split('\n');
    expect(lines.length).toBe(2);
  });

  it('idempotent within same UTC minute', () => {
    const now = '2026-01-01T10:00:30Z';

    run(['pr-reviewer', '42', 'queue:feature', '0', 'green', 'first'], {
      JAK_NOW_OVERRIDE: now,
    });
    run(['pr-reviewer', '42', 'queue:feature', '0', 'green', 'second'], {
      JAK_NOW_OVERRIDE: now,
    });

    const lines = readFileSync(tmpDir + '/agents/_label-log.jsonl', 'utf-8')
      .trim()
      .split('\n');
    // Same applied_by+pr_number+label within same minute → only one row
    expect(lines.length).toBe(1);
  });

  it('NOT idempotent across different UTC minutes (different minutes → two rows)', () => {
    const now1 = '2026-01-01T10:00:30Z';
    const now2 = '2026-01-01T10:01:30Z';

    run(['pr-reviewer', '42', 'queue:feature', '0', 'green', 'first'], {
      JAK_NOW_OVERRIDE: now1,
    });
    run(['pr-reviewer', '42', 'queue:feature', '0', 'green', 'second'], {
      JAK_NOW_OVERRIDE: now2,
    });

    const lines = readFileSync(tmpDir + '/agents/_label-log.jsonl', 'utf-8')
      .trim()
      .split('\n');
    expect(lines.length).toBe(2);
  });
});
