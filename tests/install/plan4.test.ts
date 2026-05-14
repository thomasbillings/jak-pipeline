/**
 * install.sh Plan 4 section — UAT strategy config + Compose overlay + Storybook
 * workflow + UAT lifecycle scripts.
 *
 * Uses PLAN4_ONLY=1 with JAK_PLAN1_SKIP_NPM=1 + PLAN3_ONLY=1 trick to keep the
 * fixture minimal. Actually we use PLAN3_ONLY=1 PLAN4_ONLY=1 — that combination
 * runs Plan 3 then Plan 4 (per the existing PLAN3_ONLY guard composition).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const INSTALL_SCRIPT = path.join(SKILL_ROOT, 'scripts', 'install.sh');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jak-install-plan4-'));
}

function setupMinimalDownstream(tmpDir: string): void {
  fs.mkdirSync(path.join(tmpDir, 'scripts', 'scrum-master'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'scripts', 'scrum-master', 'tick.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\necho "tick"\n',
    { mode: 0o755 }
  );
}

function runInstall(tmpDir: string, extraEnv: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [INSTALL_SCRIPT], {
      env: {
        ...process.env,
        DOWNSTREAM_ROOT: tmpDir,
        JAK_SKILL_ROOT: SKILL_ROOT,
        // PLAN3_ONLY=1 skips Plan 2 (which would need .claude/agents/pr-reviewer.md).
        // PLAN4_ONLY=1 in combination instructs the Plan 4 section to run too.
        PLAN3_ONLY: '1',
        PLAN4_ONLY: '1',
        // Plan 1 still runs unconditionally; skip its npm ci step to keep the
        // fixture deterministic (otherwise CI's network can flake).
        JAK_PLAN1_SKIP_NPM: '1',
        // Pre-flight requires .git/ + scrum-master-pipeline + CLIs; not what
        // this test is exercising.
        JAK_SKIP_PREFLIGHT: '1',
        // Plan 4 is interactive without these
        JAK_UAT_STRATEGY: 'local-docker',
        CF_PAGES_PROJECT: 'test-cf-project',
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

describe('install.sh — Plan 4 section', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    setupMinimalDownstream(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies all 5 UAT lifecycle scripts into <downstream>/scripts/jak-pipeline/uat/ as executables', async () => {
    const result = await runInstall(tmpDir);
    expect(result.exitCode).toBe(0);

    const uatDir = path.join(tmpDir, 'scripts', 'jak-pipeline', 'uat');
    for (const script of ['run.sh', 'local-docker-start.sh', 'local-docker-stop.sh', 'local-docker-accept.sh', 'local-docker-reject.sh']) {
      const p = path.join(uatDir, script);
      expect(fs.existsSync(p), `${script} should exist`).toBe(true);
      const stat = fs.statSync(p);
      expect(stat.mode & 0o111, `${script} should be executable`).not.toBe(0);
    }
  });

  it('writes JAK_UAT_STRATEGY to config.env', async () => {
    await runInstall(tmpDir);
    const config = path.join(tmpDir, '.claude', 'jak-pipeline', 'config.env');
    expect(fs.existsSync(config)).toBe(true);
    const content = fs.readFileSync(config, 'utf8');
    expect(content).toMatch(/JAK_UAT_STRATEGY=local-docker/);
  });

  it('copies the docker-compose.local-uat.yml overlay (when strategy is local-docker)', async () => {
    await runInstall(tmpDir);
    const overlay = path.join(tmpDir, 'docker', 'docker-compose.local-uat.yml');
    expect(fs.existsSync(overlay)).toBe(true);
    const content = fs.readFileSync(overlay, 'utf8');
    expect(content).toMatch(/jak-pipeline-local-uat/);
  });

  it('does NOT copy the docker-compose overlay when strategy is none', async () => {
    await runInstall(tmpDir, { JAK_UAT_STRATEGY: 'none' });
    const overlay = path.join(tmpDir, 'docker', 'docker-compose.local-uat.yml');
    expect(fs.existsSync(overlay)).toBe(false);
  });

  it('copies storybook-preview.yml with CF_PAGES_PROJECT substituted', async () => {
    await runInstall(tmpDir);
    const wf = path.join(tmpDir, '.github', 'workflows', 'storybook-preview.yml');
    expect(fs.existsSync(wf)).toBe(true);
    const content = fs.readFileSync(wf, 'utf8');
    expect(content).toContain('test-cf-project');
    expect(content).not.toContain('your-cf-pages-project');
  });

  it('writes CF_PAGES_PROJECT to config.env (idempotent on re-run)', async () => {
    await runInstall(tmpDir);
    const config = path.join(tmpDir, '.claude', 'jak-pipeline', 'config.env');
    let content = fs.readFileSync(config, 'utf8');
    expect(content).toMatch(/CF_PAGES_PROJECT=test-cf-project/);

    await runInstall(tmpDir);
    content = fs.readFileSync(config, 'utf8');
    const matches = (content.match(/CF_PAGES_PROJECT=/g) || []).length;
    expect(matches).toBe(1);
  });

  it('is idempotent — second run reports already-present for every step', async () => {
    await runInstall(tmpDir);
    const second = await runInstall(tmpDir);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/already configured/);
    expect(second.stdout).toMatch(/already exists/);
  });

  it('rejects invalid CF_PAGES_PROJECT (e.g. with shell metacharacters)', async () => {
    const result = await runInstall(tmpDir, { CF_PAGES_PROJECT: '../etc/passwd' });
    // Implementation either rejects with non-zero, or sanitises. Either way,
    // the workflow file MUST NOT contain "../etc/passwd"
    const wf = path.join(tmpDir, '.github', 'workflows', 'storybook-preview.yml');
    if (fs.existsSync(wf)) {
      const content = fs.readFileSync(wf, 'utf8');
      expect(content).not.toContain('../etc/passwd');
    }
    // exit code may be 0 or 1; what matters is sanitisation
    expect([0, 1]).toContain(result.exitCode);
  });

  // Regression for finding (c): when CF_PAGES_PROJECT is unset and stdin
  // isn't a TTY, install.sh must still write a marker line so doctor.sh can
  // distinguish "user skipped" from "config.env missing or corrupted".
  it('writes empty CF_PAGES_PROJECT= marker when unset and non-interactive', async () => {
    // Run install WITHOUT setting CF_PAGES_PROJECT (override via empty string)
    const result = await runInstall(tmpDir, { CF_PAGES_PROJECT: '' });
    expect(result.exitCode).toBe(0);

    const config = path.join(tmpDir, '.claude', 'jak-pipeline', 'config.env');
    expect(fs.existsSync(config)).toBe(true);
    const content = fs.readFileSync(config, 'utf8');
    // The marker line must be present, with an empty value
    expect(content).toMatch(/^CF_PAGES_PROJECT=$/m);
  });
});
