/**
 * scripts/migrate-from-coordinator.sh — one-time downstream migration from
 * the pre-#70 "coordinator" layout to the current "scrum-master" layout.
 *
 * Each test builds a synthetic downstream in a temp dir with selected
 * pre-rename artifacts, runs the migration, and asserts both the rename
 * outcomes and the textual rewrites.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const MIGRATE_SCRIPT = path.join(SKILL_ROOT, 'scripts', 'migrate-from-coordinator.sh');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jak-migrate-test-'));
}

function runMigrate(downstream: string, args: string[] = []): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [MIGRATE_SCRIPT, ...args], {
      env: { ...process.env, JAK_DOWNSTREAM_ROOT: downstream },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

/**
 * Stand up a minimal pre-rename downstream: the 3 rename targets + some
 * customisable files with "coordinator" references for the rewrite to chew on.
 */
function seedPreRename(downstream: string): void {
  fs.mkdirSync(path.join(downstream, 'scripts', 'coordinator'), { recursive: true });
  fs.mkdirSync(path.join(downstream, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(downstream, '.claude', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(downstream, '.claude', 'mcp', 'mergify'), { recursive: true });

  // Renamed directory
  fs.writeFileSync(path.join(downstream, 'scripts', 'coordinator', 'tick.sh'), '#!/usr/bin/env bash\necho tick\n');
  fs.writeFileSync(path.join(downstream, 'scripts', 'coordinator', 'lib.sh'), '#!/usr/bin/env bash\n# coordinator lib\n');

  // Renamed files
  fs.writeFileSync(path.join(downstream, '.coordinator-pipeline.json'), '{"plan_repo":"foo/bar"}\n');
  fs.writeFileSync(
    path.join(downstream, '.claude', 'commands', 'coordinator-tick.md'),
    '# Coordinator tick\nYou are the coordinator. Run /coordinator-tick.\n'
  );

  // User-customisable files with refs to rewrite
  fs.writeFileSync(
    path.join(downstream, '.claude', 'agents', 'planner.md'),
    `---
description: Planner for the coordinator pipeline. Coordinates planning.
---
Hand off to the coordinator via /coordinator-tick.
Note: this is about coordination, not subordination.
`
  );
  fs.writeFileSync(
    path.join(downstream, '.claude', 'agents', 'dev-agent.md'),
    'See scripts/coordinator/lib.sh.\nThe coordinator picks this up.\n'
  );
  fs.writeFileSync(
    path.join(downstream, '.claude', 'mcp', 'mergify', '.env'),
    '# Allowed values: coordinator | pr-reviewer | dev-agent | planner\nMERGIFY_MCP_ROLE=coordinator\n'
  );
}

describe('migrate-from-coordinator.sh', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-op when no pre-rename artifacts exist', async () => {
    // Empty downstream
    fs.mkdirSync(path.join(tmpDir, 'scripts', 'scrum-master'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.scrum-master.json'), '{}\n');

    const result = await runMigrate(tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/already migrated/i);
  });

  it('dry-run reports the plan without modifying anything', async () => {
    seedPreRename(tmpDir);
    const planner = path.join(tmpDir, '.claude', 'agents', 'planner.md');
    const before = fs.readFileSync(planner, 'utf8');

    const result = await runMigrate(tmpDir, ['--dry-run']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/DRY-RUN/);
    expect(result.stdout).toMatch(/\[RENAME-DIR\].*scripts\/coordinator/);
    expect(result.stdout).toMatch(/\[RENAME-FILE\].*\.coordinator-pipeline\.json/);
    expect(result.stdout).toMatch(/\[REWRITE\].*planner\.md/);

    // Nothing actually moved
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'coordinator'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'scrum-master'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.coordinator-pipeline.json'))).toBe(true);
    expect(fs.readFileSync(planner, 'utf8')).toBe(before);
  });

  it('renames directory + files + rewrites references in customisable files', async () => {
    seedPreRename(tmpDir);

    const result = await runMigrate(tmpDir, ['--no-git-mv']);
    expect(result.exitCode).toBe(0);

    // Directory rename
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'coordinator'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'scrum-master', 'tick.sh'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'scrum-master', 'lib.sh'))).toBe(true);

    // File renames
    expect(fs.existsSync(path.join(tmpDir, '.coordinator-pipeline.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.scrum-master.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'coordinator-tick.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'scrum-master.md'))).toBe(true);

    // Content rewrites — planner.md
    const planner = fs.readFileSync(path.join(tmpDir, '.claude', 'agents', 'planner.md'), 'utf8');
    expect(planner).toContain('scrum-master pipeline');
    expect(planner).toContain('/scrum-master');
    expect(planner).not.toMatch(/\bcoordinator\b/);
    expect(planner).not.toMatch(/coordinator-tick/);
    // Word-boundary preserves "coordination" and "Coordinates"
    expect(planner).toContain('coordination');
    expect(planner).toContain('Coordinates');

    // dev-agent.md
    const dev = fs.readFileSync(path.join(tmpDir, '.claude', 'agents', 'dev-agent.md'), 'utf8');
    expect(dev).toContain('scripts/scrum-master/lib.sh');
    expect(dev).toContain('The scrum-master picks this up.');

    // .env: MERGIFY_MCP_ROLE value rewritten + comment Allowed values updated
    const env = fs.readFileSync(path.join(tmpDir, '.claude', 'mcp', 'mergify', '.env'), 'utf8');
    expect(env).toContain('MERGIFY_MCP_ROLE=scrum-master');
    expect(env).toContain('Allowed values: scrum-master |');
    expect(env).not.toMatch(/=coordinator\b/);
  });

  it('idempotent: second run is a no-op', async () => {
    seedPreRename(tmpDir);
    await runMigrate(tmpDir, ['--no-git-mv']);

    // Capture state after first run
    const plannerAfter1 = fs.readFileSync(path.join(tmpDir, '.claude', 'agents', 'planner.md'), 'utf8');
    const cmdAfter1 = fs.readFileSync(path.join(tmpDir, '.claude', 'commands', 'scrum-master.md'), 'utf8');

    // Second run
    const result = await runMigrate(tmpDir, ['--no-git-mv']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/already migrated/i);

    // Files unchanged
    expect(fs.readFileSync(path.join(tmpDir, '.claude', 'agents', 'planner.md'), 'utf8')).toBe(plannerAfter1);
    expect(fs.readFileSync(path.join(tmpDir, '.claude', 'commands', 'scrum-master.md'), 'utf8')).toBe(cmdAfter1);
  });

  it('handles missing optional artifacts (only some pre-rename artifacts present)', async () => {
    // Only the coordinator dir exists; no .coordinator-pipeline.json, no coordinator-tick.md
    fs.mkdirSync(path.join(tmpDir, 'scripts', 'coordinator'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'scripts', 'coordinator', 'tick.sh'), '#!/usr/bin/env bash\n');

    const result = await runMigrate(tmpDir, ['--no-git-mv']);
    expect(result.exitCode).toBe(0);

    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'coordinator'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'scrum-master'))).toBe(true);
  });

  it('--help prints usage', async () => {
    const result = await runMigrate(tmpDir, ['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Usage:/);
    expect(result.stdout).toMatch(/dry-run/);
  });

  it('exits 1 on unknown flag', async () => {
    seedPreRename(tmpDir);
    const result = await runMigrate(tmpDir, ['--bogus']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unknown flag/);
  });
});
