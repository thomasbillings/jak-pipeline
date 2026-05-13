import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Repo root (4 levels up from this test file)
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const HOOK_SCRIPT = resolve(REPO_ROOT, 'scripts', 'hooks', 'pre-commit');

function setupTempRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'jak-hook-test-'));
  execSync('git init', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  // Create an initial commit so the repo has a HEAD
  writeFileSync(resolve(dir, 'README.md'), '# test');
  execSync('git add README.md', { cwd: dir });
  execSync('git commit -m "init"', { cwd: dir });
  return dir;
}

function runHook(repoDir: string): { status: number | null; stderr: string } {
  const result = spawnSync('bash', [HOOK_SCRIPT], {
    cwd: repoDir,
    encoding: 'utf-8',
    env: { ...process.env, GIT_DIR: resolve(repoDir, '.git') },
  });
  return { status: result.status, stderr: result.stderr };
}

function stageFile(repoDir: string, filename: string, content: string): void {
  writeFileSync(resolve(repoDir, filename), content);
  execSync(`git add ${filename}`, { cwd: repoDir });
}

describe('pre-commit hook (a10)', () => {
  it('hook script exists and is executable', () => {
    const result = spawnSync('test', ['-x', HOOK_SCRIPT]);
    expect(result.status).toBe(0);
  });

  it('exits 0 when staged content has no token prefixes', () => {
    const dir = setupTempRepo();
    try {
      stageFile(dir, 'clean.txt', 'nothing sensitive here\nsome_api_key=not_a_real_token\n');
      const { status } = runHook(dir);
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when staged content contains ghp_ token', () => {
    const dir = setupTempRepo();
    try {
      stageFile(dir, 'secret.txt', 'GITHUB_TOKEN=ghp_FAKEFAKEFAKEFAKE1234567890\n');
      const { status, stderr } = runHook(dir);
      expect(status).not.toBe(0);
      expect(stderr).toContain('BLOCKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when staged content contains ghs_ token', () => {
    const dir = setupTempRepo();
    try {
      stageFile(dir, 'secret.txt', 'session=ghs_FAKEFAKEFAKEFAKE1234567890\n');
      const { status } = runHook(dir);
      expect(status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when staged content contains github_pat_ token', () => {
    const dir = setupTempRepo();
    try {
      stageFile(dir, 'secret.txt', 'TOKEN=github_pat_FAKETOKEN_1234567890abcdef\n');
      const { status, stderr } = runHook(dir);
      expect(status).not.toBe(0);
      expect(stderr).toContain('BLOCKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when staged content contains mrg_live_ token', () => {
    const dir = setupTempRepo();
    try {
      stageFile(dir, 'secret.txt', 'MERGIFY_API_KEY=mrg_live_FAKEFAKEFAKE1234567890\n');
      const { status } = runHook(dir);
      expect(status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when staged content contains mrg_test_ token', () => {
    const dir = setupTempRepo();
    try {
      stageFile(dir, 'secret.txt', 'MERGIFY_API_KEY=mrg_test_FAKEFAKEFAKE1234567890\n');
      const { status } = runHook(dir);
      expect(status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when staged content contains ghr_ token', () => {
    const dir = setupTempRepo();
    try {
      stageFile(dir, 'secret.txt', 'REFRESH_TOKEN=ghr_FAKEFAKEFAKE1234567890\n');
      const { status, stderr } = runHook(dir);
      expect(status).not.toBe(0);
      expect(stderr).toContain('BLOCKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 2026-05-13 audit expansion: newer GitHub token formats
  it('exits non-zero when staged content contains gho_ (OAuth) token', () => {
    const dir = setupTempRepo();
    try {
      stageFile(dir, 'secret.txt', 'OAUTH_TOKEN=gho_FAKEFAKEFAKE1234567890\n');
      const { status, stderr } = runHook(dir);
      expect(status).not.toBe(0);
      expect(stderr).toContain('BLOCKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when staged content contains ghu_ (user-to-server) token', () => {
    const dir = setupTempRepo();
    try {
      stageFile(dir, 'secret.txt', 'USER_TOKEN=ghu_FAKEFAKEFAKE1234567890\n');
      const { status, stderr } = runHook(dir);
      expect(status).not.toBe(0);
      expect(stderr).toContain('BLOCKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when staged content contains ghe_ (enterprise) token', () => {
    const dir = setupTempRepo();
    try {
      stageFile(dir, 'secret.txt', 'ENTERPRISE_TOKEN=ghe_FAKEFAKEFAKE1234567890\n');
      const { status, stderr } = runHook(dir);
      expect(status).not.toBe(0);
      expect(stderr).toContain('BLOCKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not block on unstaged content containing tokens', () => {
    const dir = setupTempRepo();
    try {
      // Write file with token but do NOT stage it
      writeFileSync(resolve(dir, 'unstaged.txt'), 'GITHUB_TOKEN=ghp_FAKEFAKEFAKEFAKE1234567890\n');
      // Stage a clean file instead
      stageFile(dir, 'clean.txt', 'no tokens here\n');
      const { status } = runHook(dir);
      // Hook only checks staged content; unstaged file must not trigger it
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
