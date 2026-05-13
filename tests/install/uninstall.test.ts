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
  fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'scripts', 'coordinator'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'scripts', 'coordinator', 'tick.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\necho "tick"\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md'), '# pr-reviewer\nStub.\n');
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

  it('restores pr-reviewer.md to pre-install state (strips overlay sentinel block)', () => {
    runInstall(tmpDir);
    runUninstall(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md'), 'utf8');
    expect(content).toBe('# pr-reviewer\nStub.\n');
  });

  it('strips the jak_pipeline_jira_tick_pass block from tick.sh', () => {
    runInstall(tmpDir);
    runUninstall(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'scripts', 'coordinator', 'tick.sh'), 'utf8');
    expect(content).not.toContain('jak_pipeline_jira_tick_pass');
    expect(content).toContain('echo "tick"');
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
    // Do NOT install. Just uninstall.
    const r = runUninstall(tmpDir);
    expect(r.status).toBe(0);
    // Pre-existing files preserved
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'coordinator', 'tick.sh'))).toBe(true);
  });
});
