/**
 * scripts/update.sh — refresh skill-owned files from upstream without
 * touching customisable templates or user config.
 *
 * Each test builds a fake downstream in a temp dir, optionally copies in
 * "as installed" versions of skill files (and modifies some), then runs
 * update.sh against the real jak-pipeline tree and asserts behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const UPDATE_SCRIPT = path.join(SKILL_ROOT, 'scripts', 'update.sh');
const MANIFEST_TSV = path.join(SKILL_ROOT, 'templates', 'install-manifest.tsv');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jak-update-test-'));
}

interface ManifestRow {
  src: string;
  dst: string;
  category: string;
}

function readManifest(): ManifestRow[] {
  const text = fs.readFileSync(MANIFEST_TSV, 'utf8');
  const rows: ManifestRow[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('src_path')) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    rows.push({ src: parts[0], dst: parts[1], category: parts[2] });
  }
  return rows;
}

function sha256(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function runUpdate(downstream: string, args: string[] = []): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [UPDATE_SCRIPT, ...args], {
      env: {
        ...process.env,
        JAK_SKILL_ROOT: SKILL_ROOT,
        JAK_DOWNSTREAM_ROOT: downstream,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

/**
 * Copy the upstream version of a tracked file into the downstream — simulating
 * "as installed by install.sh". Returns the destination absolute path.
 */
function seedFromUpstream(downstream: string, manifestEntry: ManifestRow): string {
  const src = path.join(SKILL_ROOT, manifestEntry.src);
  const dst = path.join(downstream, manifestEntry.dst);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return dst;
}

/**
 * Write a state manifest mirroring "everything matches upstream exactly".
 * Lets tests skip a real install.sh run and jump straight to update.sh.
 */
function seedStateManifest(downstream: string, hashesOverride: Record<string, string> = {}): void {
  const manifest = readManifest();
  const stateDir = path.join(downstream, '.claude', 'jak-pipeline');
  fs.mkdirSync(stateDir, { recursive: true });
  const files: Record<string, { installed_hash: string; category: string; src: string }> = {};
  for (const row of manifest) {
    const upstreamSrc = path.join(SKILL_ROOT, row.src);
    const hash = hashesOverride[row.dst] ?? (fs.existsSync(upstreamSrc) ? sha256(upstreamSrc) : '');
    files[row.dst] = {
      installed_hash: hash,
      category: row.category,
      src: row.src,
    };
  }
  fs.writeFileSync(
    path.join(stateDir, 'install-manifest.json'),
    JSON.stringify({ schema_version: 1, upstream_sha: 'test-sha', updated_at: 'test', files }, null, 2) + '\n'
  );
}

describe('update.sh — refresh skill-owned files', () => {
  let tmpDir: string;
  let manifest: ManifestRow[];

  beforeEach(() => {
    tmpDir = makeTempDir();
    manifest = readManifest();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('manifest TSV parses to ≥ 19 rows with valid categories', () => {
    expect(manifest.length).toBeGreaterThanOrEqual(19);
    const validCats = new Set(['skill', 'skill-append']);
    for (const row of manifest) {
      expect(validCats.has(row.category)).toBe(true);
      // Every src must exist
      expect(fs.existsSync(path.join(SKILL_ROOT, row.src))).toBe(true);
    }
    // Exactly one skill-append entry (tick.sh)
    const appendRows = manifest.filter((r) => r.category === 'skill-append');
    expect(appendRows.length).toBe(1);
    expect(appendRows[0].dst).toMatch(/tick\.sh$/);
  });

  it('bootstrap (no state file): installs missing files + writes a fresh state manifest', async () => {
    const result = await runUpdate(tmpDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/bootstrapping/i);

    // Every skill file should exist in the downstream now
    for (const row of manifest) {
      const dst = path.join(tmpDir, row.dst);
      expect(fs.existsSync(dst), `${row.dst} should exist`).toBe(true);
    }

    // State manifest written
    const statePath = path.join(tmpDir, '.claude', 'jak-pipeline', 'install-manifest.json');
    expect(fs.existsSync(statePath)).toBe(true);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.schema_version).toBe(1);
    expect(Object.keys(state.files).length).toBe(manifest.length);
    for (const row of manifest) {
      expect(state.files[row.dst].installed_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('no-op when everything is already in sync with upstream', async () => {
    // Seed everything from upstream first
    for (const row of manifest) seedFromUpstream(tmpDir, row);
    seedStateManifest(tmpDir);

    const result = await runUpdate(tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Summary: updated 0/);

    // No .bak files were created
    for (const row of manifest) {
      expect(fs.existsSync(path.join(tmpDir, row.dst + '.bak'))).toBe(false);
    }
  });

  it('refreshes a skill file when upstream has changed', async () => {
    // Pick a tractable skill file (not skill-append).
    const target = manifest.find((r) => r.category === 'skill' && r.dst.endsWith('lib.sh'))!;
    const dst = path.join(tmpDir, target.dst);

    // Seed the downstream with an OLD version (a deliberately different
    // payload). State manifest records OLD hash as "installed".
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const oldContent = '#!/usr/bin/env bash\n# OLD version\n';
    fs.writeFileSync(dst, oldContent);
    const oldHash = crypto.createHash('sha256').update(oldContent).digest('hex');
    seedStateManifest(tmpDir, { [target.dst]: oldHash });

    // Seed all the other manifest files in-sync to keep noise down
    for (const row of manifest) {
      if (row.dst === target.dst) continue;
      seedFromUpstream(tmpDir, row);
    }

    const result = await runUpdate(tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`\\[UPDATE\\]\\s+${target.dst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    // After update, downstream matches upstream
    expect(sha256(dst)).toBe(sha256(path.join(SKILL_ROOT, target.src)));

    // No .bak — file was at "as installed" hash, just outdated, not modified
    expect(fs.existsSync(dst + '.bak')).toBe(false);
  });

  it('backs up a locally-modified skill file to .bak before refresh', async () => {
    const target = manifest.find((r) => r.category === 'skill' && r.dst.endsWith('drain-retry-queue.sh'))!;
    const dst = path.join(tmpDir, target.dst);

    // Seed: upstream-version in downstream → that's "installed_hash" in state.
    // Then user edits the file → installed != hash-on-disk.
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const upstreamSrc = path.join(SKILL_ROOT, target.src);
    fs.copyFileSync(upstreamSrc, dst);
    const installedHash = sha256(dst);

    // Modify locally
    fs.appendFileSync(dst, '\n# LOCAL EDIT — please preserve\n');
    const modifiedContent = fs.readFileSync(dst, 'utf8');

    // State manifest knows the original installed hash
    seedStateManifest(tmpDir, { [target.dst]: installedHash });
    for (const row of manifest) {
      if (row.dst === target.dst) continue;
      seedFromUpstream(tmpDir, row);
    }

    const result = await runUpdate(tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/UPDATE\+BACKUP/);

    // .bak preserves the local edit
    const bak = dst + '.bak';
    expect(fs.existsSync(bak)).toBe(true);
    expect(fs.readFileSync(bak, 'utf8')).toBe(modifiedContent);

    // dst now matches upstream
    expect(sha256(dst)).toBe(sha256(upstreamSrc));
  });

  it('skill-append (tick.sh): re-applies Jira hook when sentinel was present pre-refresh', async () => {
    const target = manifest.find((r) => r.category === 'skill-append')!;
    const dst = path.join(tmpDir, target.dst);
    const upstreamSrc = path.join(SKILL_ROOT, target.src);

    // Build the "as installed by install.sh" version: upstream tick.sh + the
    // 4-line Jira hook block appended at the end.
    const upstreamText = fs.readFileSync(upstreamSrc, 'utf8');
    const hookBlock = '\n# jak-pipeline: Jira tick pass\n. "$(dirname "${BASH_SOURCE[0]}")/../jak-pipeline/jira/tick-extension.sh"\njak_pipeline_jira_tick_pass\n';
    fs.mkdirSync(path.dirname(dst), { recursive: true });

    // Simulate upstream having drifted — write an OLD tick.sh + hook
    const oldTickContent = '#!/usr/bin/env bash\nset -euo pipefail\necho "OLD tick"\n' + hookBlock;
    fs.writeFileSync(dst, oldTickContent);
    const oldHash = sha256(dst);

    seedStateManifest(tmpDir, { [target.dst]: oldHash });
    for (const row of manifest) {
      if (row.dst === target.dst) continue;
      seedFromUpstream(tmpDir, row);
    }

    const result = await runUpdate(tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/re-applied jak_pipeline_jira_tick_pass hook/);

    // After update: file starts with upstream content + ends with hook block
    const refreshed = fs.readFileSync(dst, 'utf8');
    expect(refreshed.startsWith(upstreamText)).toBe(true);
    expect(refreshed).toContain('jak_pipeline_jira_tick_pass');
    expect(refreshed).toContain('tick-extension.sh');

    // No spurious .bak (file was at installed-hash)
    expect(fs.existsSync(dst + '.bak')).toBe(false);

    // _Not_ contained twice — sentinel is the suffix once, not twice
    const sentinelCount = (refreshed.match(/jak_pipeline_jira_tick_pass/g) || []).length;
    expect(sentinelCount).toBe(1);
  });

  it('skill-append: does NOT re-apply Jira hook if sentinel was absent', async () => {
    const target = manifest.find((r) => r.category === 'skill-append')!;
    const dst = path.join(tmpDir, target.dst);

    // Old tick.sh WITHOUT the Jira hook (user opted out, or pre-Plan-3 install)
    const oldNoHook = '#!/usr/bin/env bash\nset -euo pipefail\necho "OLD tick, no jira"\n';
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, oldNoHook);
    seedStateManifest(tmpDir, { [target.dst]: sha256(dst) });
    for (const row of manifest) {
      if (row.dst === target.dst) continue;
      seedFromUpstream(tmpDir, row);
    }

    const result = await runUpdate(tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/re-applied jak_pipeline_jira_tick_pass/);

    const refreshed = fs.readFileSync(dst, 'utf8');
    expect(refreshed).not.toContain('jak_pipeline_jira_tick_pass');
  });

  it('--dry-run modifies nothing on disk', async () => {
    // Seed an out-of-sync skill file
    const target = manifest.find((r) => r.category === 'skill' && r.dst.endsWith('lib.sh'))!;
    const dst = path.join(tmpDir, target.dst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const stale = '#!/usr/bin/env bash\n# stale\n';
    fs.writeFileSync(dst, stale);
    seedStateManifest(tmpDir, { [target.dst]: sha256(dst) });

    for (const row of manifest) {
      if (row.dst === target.dst) continue;
      seedFromUpstream(tmpDir, row);
    }

    const before = fs.readFileSync(dst, 'utf8');
    const result = await runUpdate(tmpDir, ['--dry-run']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/DRY-RUN/);
    expect(result.stdout).toMatch(/would update 1/);

    // File unchanged
    expect(fs.readFileSync(dst, 'utf8')).toBe(before);
    // State file NOT written during dry-run if it didn't exist before
    const statePath = path.join(tmpDir, '.claude', 'jak-pipeline', 'install-manifest.json');
    // It DID exist from seedStateManifest above; that's fine — assert it's unchanged.
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.upstream_sha).toBe('test-sha');
  });

  it('exits 1 with an error if --foo is passed', async () => {
    const result = await runUpdate(tmpDir, ['--foo']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unknown flag/i);
  });

  it('--help prints usage and exits 0', async () => {
    const result = await runUpdate(tmpDir, ['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Usage:/);
    expect(result.stdout).toMatch(/dry-run/);
  });
});

describe('install.sh — state manifest write at end', () => {
  // This is a thin smoke test for the install.sh tail block. We can't easily
  // run a full install.sh here (preflight, Plans 0-4 dependencies), so instead
  // run a focused invocation that exits after the Plan 4 success path with the
  // state manifest written.

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes .claude/jak-pipeline/install-manifest.json with all manifest entries', async () => {
    // Mirror plan4.test.ts setup
    fs.mkdirSync(path.join(tmpDir, 'scripts', 'scrum-master'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'scripts', 'scrum-master', 'tick.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\necho "tick"\n',
      { mode: 0o755 }
    );
    fs.mkdirSync(path.join(tmpDir, '.claude', 'agents'), { recursive: true });
    // Pre-seed pr-reviewer.md so Plan 2 doesn't fail
    fs.writeFileSync(path.join(tmpDir, '.claude', 'agents', 'pr-reviewer.md'), '# pr-reviewer placeholder\n');

    const installScript = path.join(SKILL_ROOT, 'scripts', 'install.sh');
    const child = spawn('bash', [installScript], {
      env: {
        ...process.env,
        DOWNSTREAM_ROOT: tmpDir,
        JAK_SKILL_ROOT: SKILL_ROOT,
        PLAN3_ONLY: '1',
        PLAN4_ONLY: '1',
        JAK_PLAN1_SKIP_NPM: '1',
        JAK_SKIP_PREFLIGHT: '1',
        JAK_UAT_STRATEGY: 'local-docker',
        CF_PAGES_PROJECT: 'test',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    await new Promise<void>((res) => child.on('close', () => res()));

    const statePath = path.join(tmpDir, '.claude', 'jak-pipeline', 'install-manifest.json');
    expect(fs.existsSync(statePath), `state manifest expected at ${statePath}\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(true);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.schema_version).toBe(1);
    expect(Object.keys(state.files).length).toBeGreaterThanOrEqual(19);
  }, 30_000);
});
