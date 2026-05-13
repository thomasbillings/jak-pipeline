/**
 * a16: install.sh Plan 3 section — temp-dir downstream simulation + idempotence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runScript, scriptPath, makeTempDir } from './_stub-jira.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const INSTALL_SCRIPT = scriptPath('../install.sh');

// Helper to set up a minimal downstream project skeleton
function makeDownstreamSkeleton(tmpDir: string): void {
  fs.mkdirSync(path.join(tmpDir, 'scripts', 'coordinator'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.claude', 'jira'), { recursive: true });

  // Minimal tick.sh
  const tickSh = path.join(tmpDir, 'scripts', 'coordinator', 'tick.sh');
  fs.writeFileSync(tickSh, `#!/usr/bin/env bash\nset -euo pipefail\necho "tick"\n`);
  fs.chmodSync(tickSh, 0o755);
}

describe('install.sh — Plan 3 section (a16)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies jira scripts to <downstream>/scripts/jak-pipeline/jira/', async () => {
    makeDownstreamSkeleton(tmpDir);

    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('bash', [INSTALL_SCRIPT], {
        env: {
          ...process.env,
          DOWNSTREAM_ROOT: tmpDir,
          PLAN3_ONLY: '1',  // signal to only run Plan 3 section
          JAK_SKIP_PREFLIGHT: '1'
        }
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
    });

    expect(result.exitCode).toBe(0);

    // Check transition.sh was copied
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'jak-pipeline', 'jira', 'transition.sh'))).toBe(true);
    // Check provision-board.sh was copied
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'jak-pipeline', 'jira', 'provision-board.sh'))).toBe(true);
    // Check drain-retry-queue.sh was copied
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'jak-pipeline', 'jira', 'drain-retry-queue.sh'))).toBe(true);
    // Check tick-extension.sh was copied
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'jak-pipeline', 'jira', 'tick-extension.sh'))).toBe(true);
    // Check lib/kanban-order.sh was copied
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'jak-pipeline', 'jira', 'lib', 'kanban-order.sh'))).toBe(true);
  });

  it('creates .claude/jira/.env from template if not existing', async () => {
    makeDownstreamSkeleton(tmpDir);

    await new Promise<void>((resolve) => {
      const child = spawn('bash', [INSTALL_SCRIPT], {
        env: { ...process.env, DOWNSTREAM_ROOT: tmpDir, PLAN3_ONLY: '1', JAK_SKIP_PREFLIGHT: '1' }
      });
      child.on('close', () => resolve());
    });

    const envFile = path.join(tmpDir, '.claude', 'jira', '.env');
    expect(fs.existsSync(envFile)).toBe(true);
    const content = fs.readFileSync(envFile, 'utf8');
    // Should have template keys
    expect(content).toMatch(/JIRA_BASE_URL/);
    expect(content).toMatch(/JIRA_EMAIL/);
    expect(content).toMatch(/JIRA_API_TOKEN/);
  });

  it('appends exactly one source line to tick.sh', async () => {
    makeDownstreamSkeleton(tmpDir);

    await new Promise<void>((resolve) => {
      const child = spawn('bash', [INSTALL_SCRIPT], {
        env: { ...process.env, DOWNSTREAM_ROOT: tmpDir, PLAN3_ONLY: '1', JAK_SKIP_PREFLIGHT: '1' }
      });
      child.on('close', () => resolve());
    });

    const tickContent = fs.readFileSync(
      path.join(tmpDir, 'scripts', 'coordinator', 'tick.sh'),
      'utf8'
    );
    const sourceMatches = (tickContent.match(/jak_pipeline_jira_tick_pass/g) || []).length;
    expect(sourceMatches).toBe(1);
    // Verify the source path resolves to the correct relative location:
    // tick.sh is at scripts/coordinator/tick.sh, tick-extension.sh at
    // scripts/jak-pipeline/jira/tick-extension.sh — requires one "../" step up.
    expect(tickContent).toContain('/../jak-pipeline/jira/tick-extension.sh');
  });

  it('is idempotent — second run does not duplicate tick.sh line', async () => {
    makeDownstreamSkeleton(tmpDir);

    const runInstall = () =>
      new Promise<void>((resolve) => {
        const child = spawn('bash', [INSTALL_SCRIPT], {
          env: { ...process.env, DOWNSTREAM_ROOT: tmpDir, PLAN3_ONLY: '1', JAK_SKIP_PREFLIGHT: '1' }
        });
        child.on('close', () => resolve());
      });

    await runInstall();
    await runInstall();

    const tickContent = fs.readFileSync(
      path.join(tmpDir, 'scripts', 'coordinator', 'tick.sh'),
      'utf8'
    );
    const sourceMatches = (tickContent.match(/jak_pipeline_jira_tick_pass/g) || []).length;
    expect(sourceMatches).toBe(1);
  });

  it('does not overwrite existing .claude/jira/.env', async () => {
    makeDownstreamSkeleton(tmpDir);

    const envFile = path.join(tmpDir, '.claude', 'jira', '.env');
    fs.writeFileSync(envFile, 'JIRA_API_TOKEN=real-secret\n');

    await new Promise<void>((resolve) => {
      const child = spawn('bash', [INSTALL_SCRIPT], {
        env: { ...process.env, DOWNSTREAM_ROOT: tmpDir, PLAN3_ONLY: '1', JAK_SKIP_PREFLIGHT: '1' }
      });
      child.on('close', () => resolve());
    });

    const content = fs.readFileSync(envFile, 'utf8');
    expect(content).toContain('real-secret');
  });
});
