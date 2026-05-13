/**
 * .claude/commands/jak-{install,doctor,uninstall}.md — slash command files.
 * Verify they exist, are markdown, and reference the correct underlying scripts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const COMMANDS_DIR = path.join(SKILL_ROOT, '.claude', 'commands');

describe('.claude/commands/ slash commands', () => {
  it('jak-install.md exists and points operators at scripts/install.sh', () => {
    const p = path.join(COMMANDS_DIR, 'jak-install.md');
    expect(fs.existsSync(p)).toBe(true);
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toMatch(/scripts\/install\.sh/);
    expect(content).toMatch(/DOWNSTREAM_ROOT/);
    expect(content).toMatch(/JAK_SKILL_ROOT/);
  });

  it('jak-doctor.md exists and points operators at doctor.sh', () => {
    const p = path.join(COMMANDS_DIR, 'jak-doctor.md');
    expect(fs.existsSync(p)).toBe(true);
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toMatch(/doctor\.sh/);
    expect(content).toMatch(/DOWNSTREAM_ROOT/);
    // Plan-scoped runs documented
    expect(content).toMatch(/PLAN3_CHECK/);
    expect(content).toMatch(/PLAN4_CHECK/);
  });

  it('jak-uninstall.md exists and points operators at scripts/uninstall.sh', () => {
    const p = path.join(COMMANDS_DIR, 'jak-uninstall.md');
    expect(fs.existsSync(p)).toBe(true);
    const content = fs.readFileSync(p, 'utf8');
    expect(content).toMatch(/scripts\/uninstall\.sh/);
    expect(content).toMatch(/DOWNSTREAM_ROOT/);
    // Dry-run flag documented
    expect(content).toMatch(/JAK_UNINSTALL_DRY_RUN/);
    // User-preservation guarantee documented
    expect(content).toMatch(/agents\//);
  });

  it('all three command files have a top-level # heading (Claude Code format)', () => {
    for (const name of ['jak-install.md', 'jak-doctor.md', 'jak-uninstall.md']) {
      const p = path.join(COMMANDS_DIR, name);
      const firstLine = fs.readFileSync(p, 'utf8').split('\n')[0];
      expect(firstLine, `${name} should start with a # heading`).toMatch(/^# /);
    }
  });
});
