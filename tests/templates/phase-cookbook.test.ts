import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const COOKBOOK_PATH = resolve(REPO_ROOT, 'templates/phase-rollout-commits.md');
const TEMPLATE_PATH = resolve(REPO_ROOT, 'templates/.mergify.yml.tmpl');

const PHASES = ['Day 1-2', 'Day 3-5', 'Day 6-13', 'Day 14+'];

describe('templates/phase-rollout-commits.md', () => {
  it('file exists', () => {
    expect(existsSync(COOKBOOK_PATH)).toBe(true);
  });

  it('has one section per phase (Day 1-2, Day 3-5, Day 6-13, Day 14+)', () => {
    const content = readFileSync(COOKBOOK_PATH, 'utf-8');
    for (const phase of PHASES) {
      expect(content, `missing section for ${phase}`).toContain(phase);
    }
  });

  it('each phase section contains a unified diff snippet (--- / +++ markers)', () => {
    const content = readFileSync(COOKBOOK_PATH, 'utf-8');
    // Each phase should have a code block with diff content
    expect(content).toMatch(/```diff/);
    expect(content).toMatch(/---/);
    expect(content).toMatch(/\+\+\+/);
  });

  it('Day 6-13 section enables bug queue first', () => {
    const content = readFileSync(COOKBOOK_PATH, 'utf-8');
    // Find the Day 6-13 section and check ordering
    const day613Match = content.match(/Day 6-13[\s\S]*?(?=##|$)/);
    expect(day613Match).toBeTruthy();
    const section = day613Match![0];
    const bugPos = section.indexOf('queue:bug');
    const featurePos = section.indexOf('queue:feature');
    const designPos = section.indexOf('queue:design');
    expect(bugPos, 'queue:bug should appear in Day 6-13').toBeGreaterThan(-1);
    expect(featurePos, 'queue:feature should appear in Day 6-13').toBeGreaterThan(-1);
    expect(designPos, 'queue:design should appear in Day 6-13').toBeGreaterThan(-1);
    expect(bugPos, 'bug before feature').toBeLessThan(featurePos);
    expect(featurePos, 'feature before design').toBeLessThan(designPos);
  });

  it('Day 14+ section includes guard for already-absent auto-update-prs.yml', () => {
    const content = readFileSync(COOKBOOK_PATH, 'utf-8');
    // Split on ## headings to find the Day 14+ section
    const sections = content.split(/^## /m);
    const day14Section = sections.find((s) => s.startsWith('Day 14+'));
    expect(day14Section, 'Day 14+ section not found').toBeTruthy();
    const section = 'Day 14+' + day14Section!;
    expect(section).toContain('auto-update-prs.yml');
    // Should have a guard (already absent / no-op style)
    expect(section).toMatch(/already absent|no-op|\[ -f/i);
  });

  it('diffs use disabled key removal (not setting disabled: false)', () => {
    const content = readFileSync(COOKBOOK_PATH, 'utf-8');
    // The diffs should remove the disabled: true line, not add disabled: false
    expect(content).not.toMatch(/\+\s*disabled:\s*false/);
  });

  it('each diff applies cleanly to the template via git apply --check', () => {
    if (!existsSync(TEMPLATE_PATH)) {
      // Template not yet created in red phase — skip this check
      return;
    }

    const tmpDir = os.tmpdir() + '/jak-phase-cookbook-test-' + Date.now();
    mkdirSync(tmpDir, { recursive: true });

    try {
      // Init a git repo and copy the template as root-level .mergify.yml
      // (matches how install.sh places it: cp .mergify.yml.tmpl <project>/.mergify.yml)
      spawnSync('git', ['init'], { cwd: tmpDir });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      writeFileSync(tmpDir + '/.mergify.yml', readFileSync(TEMPLATE_PATH, 'utf-8'));
      spawnSync('git', ['add', '-A'], { cwd: tmpDir });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

      const content = readFileSync(COOKBOOK_PATH, 'utf-8');
      // Extract diff blocks from the cookbook (only blocks that start with ---)
      const diffBlocks = content.match(/```diff\n([\s\S]*?)```/g) ?? [];
      const unifiedDiffs = diffBlocks.filter((b) => b.includes('--- a/'));

      expect(unifiedDiffs.length, 'expected at least 5 unified diff blocks (one per queue enable)').toBeGreaterThanOrEqual(5);

      // Apply diffs sequentially — each one modifies the file so subsequent diffs
      // use context matching rather than exact line numbers.
      for (const block of unifiedDiffs) {
        const diff = block.replace(/^```diff\n/, '').replace(/```$/, '');
        const diffPath = tmpDir + '/test.patch';
        writeFileSync(diffPath, diff);
        // --check verifies the patch can apply; --3way allows context offset after prior patches
        const checkResult = spawnSync('git', ['apply', '--check', '--3way', diffPath], {
          cwd: tmpDir,
          encoding: 'utf-8',
        });
        expect(
          checkResult.status,
          `git apply --check failed for diff block:\n${diff}\nstderr: ${checkResult.stderr}`,
        ).toBe(0);
        // Actually apply so subsequent diffs see the updated file
        spawnSync('git', ['apply', diffPath], { cwd: tmpDir });
        spawnSync('git', ['add', '-A'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'apply'], { cwd: tmpDir });
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
