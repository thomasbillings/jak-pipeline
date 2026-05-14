/**
 * uninstall.sh — reverses install.sh, preserves user-generated content.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const INSTALL_SCRIPT = path.join(SKILL_ROOT, 'scripts', 'install.sh');
const UNINSTALL_SCRIPT = path.join(SKILL_ROOT, 'scripts', 'uninstall.sh');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jak-uninstall-'));
}

function setupDownstream(tmpDir: string): void {
  // Plan 0 now installs the scrum-master scaffolding (tick.sh, planner.md, etc.)
  // so we only seed an empty git repo here. Plan 2's pr-reviewer.md is still
  // overlay-appended; that overlay is being replaced in PR-K.
  fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
}

function runInstall(tmpDir: string): void {
  const r = spawnSync('bash', [INSTALL_SCRIPT], {
    env: {
      ...process.env,
      DOWNSTREAM_ROOT: tmpDir,
      JAK_SKILL_ROOT: SKILL_ROOT,
      JAK_UAT_STRATEGY: 'local-docker',
      CF_PAGES_PROJECT: 'test-cf-project',
      JAK_PLAN1_SKIP_NPM: '1',
      JAK_SKIP_PREFLIGHT: '1',
    },
  });
  if (r.status !== 0) {
    throw new Error(`install.sh failed: ${r.stderr?.toString() ?? ''}`);
  }
}

function runUninstall(tmpDir: string, extraEnv: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [UNINSTALL_SCRIPT], {
    env: {
      ...process.env,
      DOWNSTREAM_ROOT: tmpDir,
      ...extraEnv,
    },
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
  };
}

describe('uninstall.sh', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    setupDownstream(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes all installed Plan 1 / 2 / 3 / 4 files after a full install', () => {
    runInstall(tmpDir);
    const result = runUninstall(tmpDir);
    expect(result.status).toBe(0);

    // Plan 1
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'mcp', 'mergify'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'hooks', 'pre-commit'))).toBe(false);

    // Plan 2
    expect(fs.existsSync(path.join(tmpDir, '.mergify.yml'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'jak-pipeline', 'scripts'))).toBe(false);

    // Plan 3
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'jak-pipeline', 'jira'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'jira', '.env'))).toBe(false);

    // Plan 4
    expect(fs.existsSync(path.join(tmpDir, 'docker', 'docker-compose.local-uat.yml'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.github', 'workflows', 'storybook-preview.yml'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'jak-pipeline', 'uat'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'jak-pipeline', 'config.env'))).toBe(false);
  });

  it('removes tick.sh entirely (Plan 0 now owns it)', () => {
    runInstall(tmpDir);
    // Sanity: install created the file
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'scrum-master', 'tick.sh'))).toBe(true);

    runUninstall(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'scrum-master', 'tick.sh'))).toBe(false);
    // scripts/scrum-master/ dir removed if empty
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'scrum-master'))).toBe(false);
  });

  it('strips the scrum-master/jak-pipeline gitignore block (preserves pre-existing user entries)', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n.env\n');
    runInstall(tmpDir);

    let gi = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(gi).toMatch(/scrum-master pipeline.*agent state/i);

    runUninstall(tmpDir);

    gi = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(gi).not.toMatch(/scrum-master pipeline/i);
    expect(gi).toContain('node_modules/');
    expect(gi).toContain('.env');
  });

  it('strips the pre-commit and pre-push hook lines (sentinel blocks)', () => {
    runInstall(tmpDir);
    runUninstall(tmpDir);
    const preCommit = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const prePush = path.join(tmpDir, '.git', 'hooks', 'pre-push');

    if (fs.existsSync(preCommit)) {
      const c = fs.readFileSync(preCommit, 'utf8');
      expect(c).not.toContain('jak-pipeline pre-commit token-prefix scan');
    }
    if (fs.existsSync(prePush)) {
      const c = fs.readFileSync(prePush, 'utf8');
      expect(c).not.toContain('jak-pipeline branch-ticket-check');
    }
  });

  it('preserves user-generated content under agents/', () => {
    // Pre-existing agents/ data
    fs.mkdirSync(path.join(tmpDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'agents', '_label-log.jsonl'), '{"ticket":"SCRUM-1"}\n');
    fs.writeFileSync(path.join(tmpDir, 'agents', '_jira-retry.json'), '{"ticket":"SCRUM-2"}\n');

    runInstall(tmpDir);

    // Verify install didn't touch this
    expect(fs.existsSync(path.join(tmpDir, 'agents', '_label-log.jsonl'))).toBe(true);

    runUninstall(tmpDir);

    // Verify uninstall didn't touch this either
    expect(fs.existsSync(path.join(tmpDir, 'agents', '_label-log.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'agents', '_jira-retry.json'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'agents', '_label-log.jsonl'), 'utf8')).toContain('SCRUM-1');
  });

  it('preserves other entries in .mcp.json when removing mergify', () => {
    runInstall(tmpDir);
    // Add a sibling entry the user owns
    const mcpJson = path.join(tmpDir, '.mcp.json');
    const data = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
    data.mcpServers['user-tool'] = { command: 'node', args: ['./user.js'] };
    fs.writeFileSync(mcpJson, JSON.stringify(data, null, 2));

    runUninstall(tmpDir);

    expect(fs.existsSync(mcpJson)).toBe(true);
    const remaining = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
    expect(remaining.mcpServers.mergify).toBeUndefined();
    expect(remaining.mcpServers['user-tool']).toBeDefined();
  });

  it('is idempotent — second uninstall exits 0 with no errors', () => {
    runInstall(tmpDir);
    const first = runUninstall(tmpDir);
    expect(first.status).toBe(0);
    const second = runUninstall(tmpDir);
    expect(second.status).toBe(0);
    expect(second.stderr).toBe('');
  });

  it('removes the agents/_label-log.jsonl entry from .gitignore (line only — file preserved if present)', () => {
    // Pre-existing .gitignore with user entries
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n.env\n');
    runInstall(tmpDir);

    let gi = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(gi).toContain('agents/_label-log.jsonl');

    runUninstall(tmpDir);

    gi = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    expect(gi).not.toContain('agents/_label-log.jsonl');
    expect(gi).toContain('node_modules/');
    expect(gi).toContain('.env');
  });

  it('JAK_UNINSTALL_DRY_RUN=1 reports actions without removing files', () => {
    runInstall(tmpDir);
    const r = runUninstall(tmpDir, { JAK_UNINSTALL_DRY_RUN: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN/);
    expect(r.stdout).toMatch(/would remove/);

    // Files still present after dry-run
    expect(fs.existsSync(path.join(tmpDir, '.mergify.yml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'mcp', 'mergify'))).toBe(true);
  });

  it('runs cleanly on a fresh downstream with nothing installed (idempotent)', () => {
    // Pre-seed a user file that jak-pipeline does not own
    fs.mkdirSync(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'agents', 'my-user-agent.md'), '# user-owned\n');

    // Do NOT install. Just uninstall.
    const r = runUninstall(tmpDir);
    expect(r.status).toBe(0);

    // User-owned file untouched
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents', 'my-user-agent.md'))).toBe(true);
  });

  it('strips the existing-overlay sentinel block from pr-reviewer.md if a downstream had one (legacy path)', () => {
    // Even though Plan 2 now skips when pr-reviewer.md is missing, an
    // upgrading downstream may still have the legacy overlay. Verify it
    // gets cleaned up.
    fs.mkdirSync(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    const pr = path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md');
    fs.writeFileSync(pr,
      '# pr-reviewer\nMy content.\n\n<!-- jak-pipeline:pr-reviewer-label-gate v1 -->\n\nstale overlay\n'
    );

    runUninstall(tmpDir);

    const content = fs.readFileSync(pr, 'utf8');
    expect(content).not.toContain('jak-pipeline:pr-reviewer-label-gate');
    expect(content).toContain('My content.');
  });
});
