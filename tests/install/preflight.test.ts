/**
 * install.sh pre-flight section — local CLI / coordinator-pipeline / git checks.
 *
 * Pre-flight is opt-out via JAK_SKIP_PREFLIGHT=1; opt-in to remote checks via
 * JAK_REMOTE_CHECKS=1 (not tested here — would make network calls).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const INSTALL_SCRIPT = path.join(SKILL_ROOT, 'scripts', 'install.sh');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jak-preflight-'));
}

function runInstall(tmpDir: string, extraEnv: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [INSTALL_SCRIPT], {
      env: {
        ...process.env,
        DOWNSTREAM_ROOT: tmpDir,
        JAK_SKILL_ROOT: SKILL_ROOT,
        // Limit to pre-flight only — set ALL ONLY flags off so we just hit the gate
        PLAN1_ONLY: '1',  // exits after Plan 1
        JAK_PLAN1_SKIP_NPM: '1',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

describe('install.sh — pre-flight section', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('aborts when DOWNSTREAM_ROOT is not a git repository', async () => {
    // No .git/ in tmpDir
    const result = await runInstall(tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not a git repository/);
  });

  // Coordinator-pipeline is no longer a prerequisite — Plan 0 installs it.
  // Pre-flight no longer checks for tick.sh or pr-reviewer.md.

  it('passes pre-flight when downstream is a git repo (only hard requirement now)', async () => {
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    const result = await runInstall(tmpDir);
    expect(result.stdout).toMatch(/Pre-flight.*All hard checks passed/);
  });

  // Regression for PR #19's empty-array fix (install.sh:87-93).
  // Previously, `for err in "${PREFLIGHT_ERRORS[@]:-}"` expanded to a single
  // empty string under set -u and printed bogus "[Pre-flight] ✗" + "[Pre-flight] "
  // lines to stderr on every clean run.
  it('clean pre-flight emits NO bogus empty error/warning lines on stderr', async () => {
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    const result = await runInstall(tmpDir);
    // No empty "[Pre-flight] ✗ " line
    expect(result.stderr).not.toMatch(/^\[Pre-flight\] ✗ ?\s*$/m);
    // No empty "[Pre-flight]  " warning line
    expect(result.stderr).not.toMatch(/^\[Pre-flight\] \s*$/m);
  });

  it('JAK_SKIP_PREFLIGHT=1 bypasses all pre-flight checks', async () => {
    // Empty tmpDir — would normally fail multiple pre-flight checks
    const result = await runInstall(tmpDir, { JAK_SKIP_PREFLIGHT: '1' });
    // Pre-flight should print SKIP and continue
    expect(result.stdout).toMatch(/Pre-flight.*SKIP/);
    // Should not contain the "Hard checks failed" line
    expect(result.stderr).not.toMatch(/Hard checks failed/);
  });
});
