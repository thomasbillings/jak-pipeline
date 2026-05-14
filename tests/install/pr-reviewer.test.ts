/**
 * pr-reviewer agent — Plan 2 install/uninstall path.
 *
 * The pr-reviewer.md agent file is shipped wholesale by Plan 2 (copy-if-
 * missing). It contains the canonical review rubric AND the label-gate
 * logic — replacing the historical overlay-append model. Uninstall removes
 * it when we own it (detected via the canonical description marker) or
 * strips the legacy overlay sentinel block when we don't.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const INSTALL_SCRIPT = path.join(SKILL_ROOT, 'scripts', 'install.sh');
const UNINSTALL_SCRIPT = path.join(SKILL_ROOT, 'scripts', 'uninstall.sh');
const PR_REVIEWER_TEMPLATE = path.join(SKILL_ROOT, 'templates', 'agents', 'pr-reviewer.md');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jak-pr-reviewer-'));
}

function setupDownstream(tmpDir: string): void {
  fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
}

function runInstall(tmpDir: string, extraEnv: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [INSTALL_SCRIPT], {
    env: {
      ...process.env,
      DOWNSTREAM_ROOT: tmpDir,
      JAK_SKILL_ROOT: SKILL_ROOT,
      JAK_UAT_STRATEGY: 'local-docker',
      CF_PAGES_PROJECT: 'test-cf-project',
      JAK_PLAN1_SKIP_NPM: '1',
      JAK_SKIP_PREFLIGHT: '1',
      ...extraEnv,
    },
  });
  return { status: r.status ?? 1, stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '' };
}

function runUninstall(tmpDir: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [UNINSTALL_SCRIPT], {
    env: { ...process.env, DOWNSTREAM_ROOT: tmpDir },
  });
  return { status: r.status ?? 1, stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '' };
}

describe('templates/agents/pr-reviewer.md (file shape)', () => {
  it('has the Claude Code sub-agent frontmatter', () => {
    const content = fs.readFileSync(PR_REVIEWER_TEMPLATE, 'utf8');
    const lines = content.split('\n');
    expect(lines[0]).toBe('---');
    // Find the end of frontmatter
    const fmEnd = lines.indexOf('---', 1);
    expect(fmEnd).toBeGreaterThan(0);
    const frontmatter = lines.slice(1, fmEnd).join('\n');
    expect(frontmatter).toMatch(/^name: pr-reviewer$/m);
    expect(frontmatter).toMatch(/^description: /m);
    expect(frontmatter).toMatch(/^model: /m);
    expect(frontmatter).toMatch(/^tools: /m);
  });

  it('mandates the canonical **Blockers (N)** review heading format', () => {
    const content = fs.readFileSync(PR_REVIEWER_TEMPLATE, 'utf8');
    // The agent must instruct itself to use the literal **Blockers (N)** format
    // because scripts/label-gate-decide.sh greps for **Blockers (0)** as the
    // trust-boundary signal.
    expect(content).toMatch(/\*\*Blockers \(N\)\*\*/);
    expect(content).toMatch(/\*\*Should-fix \(M\)\*\*/);
    expect(content).toMatch(/\*\*Nits \(K\)\*\*/);
  });

  it('documents the branch → queue label mapping including never-apply for queue:plan', () => {
    const content = fs.readFileSync(PR_REVIEWER_TEMPLATE, 'utf8');
    expect(content).toMatch(/`fix\/\*`.*queue:bug/);
    expect(content).toMatch(/`feat\/\*`.*queue:feature/);
    expect(content).toMatch(/`chore\/\*`.*queue:infra/);
    expect(content).toMatch(/`design\/\*`.*queue:design/);
    // queue:plan must be explicitly NEVER apply
    expect(content).toMatch(/queue:plan.*NEVER/i);
  });

  it('references the installed paths for label-gate-decide.sh and label-log-append.sh', () => {
    const content = fs.readFileSync(PR_REVIEWER_TEMPLATE, 'utf8');
    expect(content).toMatch(/\.claude\/jak-pipeline\/scripts\/label-gate-decide\.sh/);
    expect(content).toMatch(/\.claude\/jak-pipeline\/scripts\/label-log-append\.sh/);
  });

  it('declares MERGIFY_MCP_ROLE=pr-reviewer expectations (read tools allowed; mutating tools refused)', () => {
    const content = fs.readFileSync(PR_REVIEWER_TEMPLATE, 'utf8');
    expect(content).toMatch(/mergify_get_queue_summary/);
    expect(content).toMatch(/mergify_check_pr_eligibility/);
    expect(content).toMatch(/mergify_set_queue_state.*coordinator-only/i);
    expect(content).toMatch(/mergify_replay_pr.*coordinator-only/i);
  });

  it('mentions both tier modes (full + fast)', () => {
    const content = fs.readFileSync(PR_REVIEWER_TEMPLATE, 'utf8');
    expect(content).toMatch(/Tier: full \| fast/);
    expect(content).toMatch(/Fast rubric/);
    expect(content).toMatch(/Full rubric/);
  });
});

describe('install.sh — pr-reviewer.md installation (Plan 2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    setupDownstream(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('installs pr-reviewer.md into .claude/agents/ on first install', () => {
    const r = runInstall(tmpDir);
    expect(r.status).toBe(0);
    const dest = path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md');
    expect(fs.existsSync(dest)).toBe(true);
    const content = fs.readFileSync(dest, 'utf8');
    expect(content).toMatch(/name: pr-reviewer/);
    expect(content).toMatch(/Reviews feature PRs for the jak-pipeline/);
  });

  it('does NOT overwrite a pre-existing pr-reviewer.md (idempotent — user may have customised)', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md'),
      '# my custom pr-reviewer\nDo not touch.\n'
    );

    runInstall(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md'), 'utf8');
    expect(content).toBe('# my custom pr-reviewer\nDo not touch.\n');
  });
});

describe('uninstall.sh — pr-reviewer.md removal (Plan 2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    setupDownstream(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes the file when we own it (canonical description marker present)', () => {
    runInstall(tmpDir);
    // Sanity
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md'))).toBe(true);

    runUninstall(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md'))).toBe(false);
  });

  it('preserves a user-owned pr-reviewer.md (no canonical description marker)', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    const dest = path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md');
    fs.writeFileSync(dest, '---\nname: pr-reviewer\ndescription: My custom reviewer.\n---\n\n# Content I wrote.\n');

    runUninstall(tmpDir);

    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toContain('Content I wrote.');
  });

  it('strips the legacy overlay sentinel block from a pre-existing user pr-reviewer.md (upgrading path)', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    const dest = path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md');
    fs.writeFileSync(dest,
      '---\nname: pr-reviewer\ndescription: My own.\n---\n\n# user-owned reviewer\n\n<!-- jak-pipeline:pr-reviewer-label-gate v1 -->\n\nstale overlay content\n'
    );

    runUninstall(tmpDir);

    const content = fs.readFileSync(dest, 'utf8');
    expect(content).not.toContain('jak-pipeline:pr-reviewer-label-gate');
    expect(content).not.toContain('stale overlay content');
    expect(content).toContain('user-owned reviewer');
  });
});
