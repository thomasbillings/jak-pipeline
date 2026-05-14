/**
 * Issue #60: dispatch.sh --resume path's --permission-mode is unexercised by tests.
 *
 * Sets up a stub `claude` binary on PATH that records its argv and exits 0.
 * Then runs `dispatch.sh --resume <slug>` against a fake worktree + journal +
 * _state.json. Asserts the stub recorded `--permission-mode bypassPermissions`.
 *
 * Parallel test exists for the fresh-dispatch path in
 * tests/scripts/dispatch-permission-mode.test.ts (created by PR #51).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DISPATCH = path.join(SKILL_ROOT, 'scripts', 'coordinator', 'dispatch.sh');
const LIB = path.join(SKILL_ROOT, 'scripts', 'coordinator', 'lib.sh');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jak-dispatch-resume-'));
}

/**
 * Build a fake downstream that satisfies `dispatch.sh --resume <slug>`:
 *   - .git/ (must be a git repo)
 *   - scripts/coordinator/{dispatch,lib}.sh (symlinked to the real scripts)
 *   - agents/_state.json with a session_id for the slug
 *   - agents/<DATE>-<SLUG>.md journal file (status: in_progress)
 *   - worktrees/<slug> with a fake worktree marker
 *   - A stub `claude` binary on PATH that records argv to a log file
 */
function setupFakeDownstream(tmpDir: string): { slug: string; date: string; stubLog: string } {
  const slug = 'test-resume-slug';
  // Use a date in the past so the glob works regardless of when the test runs
  const date = '2026-01-15';

  // Init git repo
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com',
                    'commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir });

  // Real coordinator scripts
  fs.mkdirSync(path.join(tmpDir, 'scripts', 'coordinator'), { recursive: true });
  fs.copyFileSync(DISPATCH, path.join(tmpDir, 'scripts', 'coordinator', 'dispatch.sh'));
  fs.copyFileSync(LIB, path.join(tmpDir, 'scripts', 'coordinator', 'lib.sh'));
  fs.chmodSync(path.join(tmpDir, 'scripts', 'coordinator', 'dispatch.sh'), 0o755);

  // Plan file — dispatch.sh derives DATE from this filename before branching
  // into the MODE=resume path.
  fs.mkdirSync(path.join(tmpDir, 'plans'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'plans', `${date}-${slug}.md`),
    `---\nschema_version: 1\nticket: TEST-1\ntype: feature\nstatus: dispatched\n---\n\n# test plan\n`,
  );

  // State file with a session entry for this slug
  fs.mkdirSync(path.join(tmpDir, 'agents'), { recursive: true });
  const sessionId = '11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(
    path.join(tmpDir, 'agents', '_state.json'),
    JSON.stringify({
      agents: {
        [slug]: {
          session_id: sessionId,
          status: 'in_progress',
          date,
        },
      },
    }, null, 2),
  );

  // Journal file (resume path requires it exist)
  fs.writeFileSync(
    path.join(tmpDir, 'agents', `${date}-${slug}.md`),
    `---\nstatus: in_progress\ncheckpoint: pre-impl\nsession_id: ${sessionId}\n---\n\n# journal\n`,
  );

  // Worktree dir — created in advance so dispatch.sh skips `git worktree add`
  fs.mkdirSync(path.join(tmpDir, 'worktrees', slug), { recursive: true });

  // Stub bin dir
  const stubBin = path.join(tmpDir, 'stub-bin');
  fs.mkdirSync(stubBin);
  const stubLog = path.join(tmpDir, 'claude.calls');
  const stubClaude = path.join(stubBin, 'claude');
  fs.writeFileSync(stubClaude,
    `#!/usr/bin/env bash\n# Record argv (one arg per line) and exit 0.\nprintf '%s\\n' "$@" >> "${stubLog}"\nexit 0\n`,
    { mode: 0o755 },
  );

  // Stub pgrep — the resume path uses `pgrep -f` to ensure no concurrent
  // session is running. Always exit 1 (no match) so the resume proceeds.
  const stubPgrep = path.join(stubBin, 'pgrep');
  fs.writeFileSync(stubPgrep, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });

  return { slug, date, stubLog };
}

describe('dispatch.sh --resume: --permission-mode wiring (issue #60)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes --permission-mode bypassPermissions to the resumed claude invocation', () => {
    const { slug, stubLog } = setupFakeDownstream(tmpDir);

    const stubBin = path.join(tmpDir, 'stub-bin');
    const r = spawnSync('bash', ['scripts/coordinator/dispatch.sh', '--resume', slug], {
      cwd: tmpDir,
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH}`,
      },
      encoding: 'utf8',
    });

    // dispatch.sh runs `claude -p ... &` with nohup; the parent script
    // returns before the child writes the full argv list. Wait briefly
    // for the stub to flush.
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(stubLog) && Date.now() < deadline) {
      // Busy wait — synchronous; vitest test
    }
    // Give the background nohup a moment to actually write
    spawnSync('sleep', ['0.3']);

    expect(r.status, `dispatch.sh exited non-zero: stderr=${r.stderr}`).toBe(0);
    expect(fs.existsSync(stubLog), 'stub claude was never invoked').toBe(true);

    const argv = fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean);
    expect(argv).toContain('--permission-mode');
    // bypassPermissions is the default; JAK_PERMISSION_MODE env var can override
    expect(argv).toContain('bypassPermissions');
    // Resume path uses --resume <session>, not --session-id <uuid>
    expect(argv).toContain('--resume');
    expect(argv).toContain('11111111-2222-3333-4444-555555555555');
  });

  it('honors JAK_PERMISSION_MODE env override on the --resume path', () => {
    const { slug, stubLog } = setupFakeDownstream(tmpDir);

    const stubBin = path.join(tmpDir, 'stub-bin');
    const r = spawnSync('bash', ['scripts/coordinator/dispatch.sh', '--resume', slug], {
      cwd: tmpDir,
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH}`,
        JAK_PERMISSION_MODE: 'acceptEdits',
      },
      encoding: 'utf8',
    });

    spawnSync('sleep', ['0.3']);

    expect(r.status).toBe(0);
    const argv = fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean);
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('acceptEdits');
    expect(argv).not.toContain('bypassPermissions');
  });
});
