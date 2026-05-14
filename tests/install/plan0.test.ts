/**
 * install.sh Plan 0 section — coordinator-pipeline scaffolding (absorbed
 * from the formerly separate coordinator-pipeline skill).
 *
 * Uses PLAN0_ONLY=1 + JAK_SKIP_PREFLIGHT=1 to test only the Plan 0 surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const INSTALL_SCRIPT = path.join(SKILL_ROOT, 'scripts', 'install.sh');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jak-plan0-'));
}

function runInstall(tmpDir: string, extraEnv: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [INSTALL_SCRIPT], {
      env: {
        ...process.env,
        DOWNSTREAM_ROOT: tmpDir,
        JAK_SKILL_ROOT: SKILL_ROOT,
        PLAN0_ONLY: '1',
        JAK_SKIP_PREFLIGHT: '1',
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

describe('install.sh — Plan 0 (coordinator-pipeline scaffolding)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('installs the four agent template files into .claude/agents/ and .claude/commands/', async () => {
    const r = await runInstall(tmpDir);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents', 'planner.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents', 'plan-reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents', 'dev-agent.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'coordinator-tick.md'))).toBe(true);
  });

  it('installs the four coordinator scripts to scripts/coordinator/ as executables', async () => {
    await runInstall(tmpDir);
    for (const s of ['tick.sh', 'dispatch.sh', 'lib.sh', 'check-plan.sh']) {
      const p = path.join(tmpDir, 'scripts', 'coordinator', s);
      expect(fs.existsSync(p), `${s} should exist`).toBe(true);
      expect(fs.statSync(p).mode & 0o111, `${s} should be executable`).not.toBe(0);
    }
  });

  it('installs plans/_template.md and creates the empty plans/, agents/, agents/archive/ dirs', async () => {
    await runInstall(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'plans', '_template.md'))).toBe(true);
    expect(fs.statSync(path.join(tmpDir, 'agents')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(tmpDir, 'agents', 'archive')).isDirectory()).toBe(true);
  });

  it('appends the coordinator + jak-pipeline gitignore template to .gitignore', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');

    await runInstall(tmpDir);

    const gi = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(gi).toContain('node_modules/');                  // user content preserved
    expect(gi).toMatch(/coordinator pipeline.*agent state/i);
    expect(gi).toContain('/agents/_state.json');
    expect(gi).toContain('/worktrees/');
    expect(gi).toContain('/.plan-cache/');
    expect(gi).toContain('agents/_label-log.jsonl');         // jak-pipeline additions
    expect(gi).toContain('agents/_jira-retry.json');
  });

  it('does not duplicate the gitignore block on re-run', async () => {
    await runInstall(tmpDir);
    await runInstall(tmpDir);
    const gi = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const occurrences = (gi.match(/coordinator pipeline — agent state/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('JAK_PLAN_REPO + JAK_PROJECT_NAME write .coordinator-pipeline.json non-interactively', async () => {
    await runInstall(tmpDir, { JAK_PLAN_REPO: 'foo/bar-plans', JAK_PROJECT_NAME: 'bar' });
    const cfg = path.join(tmpDir, '.coordinator-pipeline.json');
    expect(fs.existsSync(cfg)).toBe(true);
    const data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    expect(data.plan_repo).toBe('foo/bar-plans');
    expect(data.project).toBe('bar');
  });

  it('does not overwrite a pre-existing .coordinator-pipeline.json', async () => {
    const cfg = path.join(tmpDir, '.coordinator-pipeline.json');
    fs.writeFileSync(cfg, JSON.stringify({ plan_repo: 'mine/plans', project: 'mine' }));
    await runInstall(tmpDir, { JAK_PLAN_REPO: 'should-not-clobber/x' });
    const data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    expect(data.plan_repo).toBe('mine/plans');
  });

  it('does not overwrite pre-existing template files (idempotent — user may have customised)', async () => {
    fs.mkdirSync(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'agents', 'planner.md'), '# my custom planner\n');

    await runInstall(tmpDir);

    expect(fs.readFileSync(path.join(tmpDir, '.claude', 'agents', 'planner.md'), 'utf8')).toBe('# my custom planner\n');
  });

  it('is idempotent end-to-end — second run reports already-present for every step', async () => {
    await runInstall(tmpDir);
    const r = await runInstall(tmpDir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/already present/);
  });

  // PR-L2 backfills — gaps flagged by the post-merge review.

  it('appends a leading newline when .gitignore lacks a trailing newline', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/');  // NO trailing \n

    await runInstall(tmpDir);

    const gi = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    // node_modules/ must be on its own line, NOT concatenated with the next
    expect(gi).toMatch(/^node_modules\/\n/);
    expect(gi).toMatch(/coordinator pipeline/);
  });

  it('creates .gitignore from scratch when none exists at install time', async () => {
    // No pre-existing .gitignore
    expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(false);

    await runInstall(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(true);
    const gi = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(gi).toContain('/agents/_state.json');
    expect(gi).toContain('/agents/_label-log.jsonl');
  });

  it('does not overwrite pre-existing coordinator scripts (bootstrap.sh idempotence contract)', async () => {
    fs.mkdirSync(path.join(tmpDir, 'scripts', 'coordinator'), { recursive: true });
    const tickSh = path.join(tmpDir, 'scripts', 'coordinator', 'tick.sh');
    fs.writeFileSync(tickSh, '#!/usr/bin/env bash\n# my customised tick\n', { mode: 0o755 });

    await runInstall(tmpDir);

    expect(fs.readFileSync(tickSh, 'utf8')).toBe('#!/usr/bin/env bash\n# my customised tick\n');
  });

  it('fails clearly when a template source is missing (defensive)', async () => {
    // Point JAK_SKILL_ROOT at a directory that's NOT the real skill repo
    const fakeSkill = fs.mkdtempSync(path.join(os.tmpdir(), 'jak-fake-skill-'));
    try {
      // Create a fake skill root with templates dir but missing files
      fs.mkdirSync(path.join(fakeSkill, 'templates', 'agents'), { recursive: true });
      fs.mkdirSync(path.join(fakeSkill, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(fakeSkill, 'scripts', 'install.sh'),
        fs.readFileSync(path.join(SKILL_ROOT, 'scripts', 'install.sh'), 'utf8'));
      fs.chmodSync(path.join(fakeSkill, 'scripts', 'install.sh'), 0o755);

      const r = await runInstall(tmpDir, { JAK_SKILL_ROOT: fakeSkill });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/MISSING source/);
    } finally {
      fs.rmSync(fakeSkill, { recursive: true, force: true });
    }
  });

  // Note: the interactive TTY prompt path (install.sh:131-154) is not
  // exercised in vitest — it requires a pty wrapper. Manual testing
  // covers it; documented here as a known coverage gap.
});
