/**
 * reconcile_state_from_journals helper (lib.sh) — #48.
 *
 * The dev-agent writes only to its journal frontmatter, never to
 * agents/_state.json. Without this reconcile pass, tick.sh's "stuck"
 * detection false-positives (heartbeat appears frozen) and merged plans
 * stay eligible forever (status never flips to "done").
 *
 * This helper walks _state.json's .agents map, parses each agent's
 * journal frontmatter, and updates status / last_heartbeat / checkpoint /
 * pr_url in _state.json to match the journal.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const LIB = resolve(REPO_ROOT, 'scripts/coordinator/lib.sh');

interface JournalFields {
  plan?: string;
  status?: string;
  last_heartbeat?: string;
  checkpoint?: string;
  pr_url?: string;
}

function buildJournal(fields: JournalFields): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', '## Log', '- dummy');
  return lines.join('\n') + '\n';
}

function runReconcile(stateJson: object, journals: Record<string, string>): any {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-test-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', '_state.json'), JSON.stringify(stateJson));
  for (const [name, content] of Object.entries(journals)) {
    writeFileSync(join(dir, 'agents', name), content);
  }
  const result = spawnSync(
    'bash',
    ['-c', `cd "${dir}" && STATE_FILE=agents/_state.json bash -c '. "${LIB}" && reconcile_state_from_journals'`],
    { encoding: 'utf-8' }
  );
  if (result.status !== 0) {
    throw new Error(`reconcile failed: ${result.stderr}`);
  }
  return JSON.parse(readFileSync(join(dir, 'agents', '_state.json'), 'utf-8'));
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('reconcile_state_from_journals (lib.sh) — #48', () => {
  it('updates status/last_heartbeat/checkpoint/pr_url from a complete journal', () => {
    const state = {
      plans: {},
      agents: {
        foo: {
          plan: 'plans/2026-05-14-foo.md',
          session_id: 'abc-uuid',
          pid: 0,
          worktree: 'worktrees/foo',
          branch: 'feat/foo',
          started_at: '2026-05-14T10:00:00Z',
          last_heartbeat: '2026-05-14T10:00:00Z',
          checkpoint: 'pending',
          status: 'in_progress',
          stuck_ticks: 0,
        },
      },
    };
    const journal = buildJournal({
      plan: 'plans/2026-05-14-foo.md',
      status: 'done',
      last_heartbeat: '2026-05-14T11:30:00Z',
      checkpoint: 'done',
      pr_url: 'https://github.com/org/repo/pull/42',
    });
    const out = runReconcile(state, { '2026-05-14-foo.md': journal });
    expect(out.agents.foo.status).toBe('done');
    expect(out.agents.foo.last_heartbeat).toBe('2026-05-14T11:30:00Z');
    expect(out.agents.foo.checkpoint).toBe('done');
    expect(out.agents.foo.pr_url).toBe('https://github.com/org/repo/pull/42');
    // Untouched fields preserved
    expect(out.agents.foo.session_id).toBe('abc-uuid');
    expect(out.agents.foo.branch).toBe('feat/foo');
  });

  it('preserves _state.json field when journal omits it', () => {
    const state = {
      plans: {},
      agents: {
        foo: {
          plan: 'plans/2026-05-14-foo.md',
          last_heartbeat: '2026-05-14T10:00:00Z',
          checkpoint: 'pending',
          status: 'in_progress',
        },
      },
    };
    // Journal has only last_heartbeat — status/checkpoint/pr_url should not change.
    const journal = buildJournal({
      plan: 'plans/2026-05-14-foo.md',
      last_heartbeat: '2026-05-14T10:05:00Z',
    });
    const out = runReconcile(state, { '2026-05-14-foo.md': journal });
    expect(out.agents.foo.last_heartbeat).toBe('2026-05-14T10:05:00Z');
    expect(out.agents.foo.status).toBe('in_progress');   // preserved
    expect(out.agents.foo.checkpoint).toBe('pending');   // preserved
    expect(out.agents.foo.pr_url).toBeUndefined();       // never set
  });

  it('no-op when journal file is missing', () => {
    const state = {
      plans: {},
      agents: {
        foo: { plan: 'plans/2026-05-14-foo.md', status: 'in_progress' },
      },
    };
    const out = runReconcile(state, {});  // no journals
    expect(out.agents.foo.status).toBe('in_progress');  // unchanged
  });

  it('iterates multiple agents independently', () => {
    const state = {
      plans: {},
      agents: {
        foo: { plan: 'p/2026-05-14-foo.md', status: 'in_progress', checkpoint: 'pending' },
        bar: { plan: 'p/2026-05-14-bar.md', status: 'in_progress', checkpoint: 'pending' },
      },
    };
    const out = runReconcile(state, {
      '2026-05-14-foo.md': buildJournal({ status: 'done', checkpoint: 'done' }),
      '2026-05-14-bar.md': buildJournal({ status: 'in_progress', checkpoint: 'pr-open' }),
    });
    expect(out.agents.foo.status).toBe('done');
    expect(out.agents.foo.checkpoint).toBe('done');
    expect(out.agents.bar.status).toBe('in_progress');
    expect(out.agents.bar.checkpoint).toBe('pr-open');
  });

  it('handles quoted ticket-style values', () => {
    const state = { plans: {}, agents: { foo: { status: 'in_progress' } } };
    const journal = '---\nstatus: "done"\ncheckpoint: \'pr-open\'\n---\n';
    const out = runReconcile(state, { '2026-05-14-foo.md': journal });
    expect(out.agents.foo.status).toBe('done');
    expect(out.agents.foo.checkpoint).toBe('pr-open');
  });

  it('ignores "status:" appearing only in journal body (after frontmatter close)', () => {
    const state = { plans: {}, agents: { foo: { status: 'in_progress' } } };
    const journal = '---\nplan: x\n---\n\nstatus: BODY-OBSERVATION (not a real frontmatter)\n';
    const out = runReconcile(state, { '2026-05-14-foo.md': journal });
    expect(out.agents.foo.status).toBe('in_progress');  // body-level "status:" ignored
  });

  it('idempotent: re-running with no journal changes is a no-op', () => {
    const state = {
      plans: {},
      agents: { foo: { status: 'in_progress', last_heartbeat: '2026-05-14T10:00:00Z' } },
    };
    const journal = buildJournal({ status: 'done', last_heartbeat: '2026-05-14T11:00:00Z' });
    const out1 = runReconcile(state, { '2026-05-14-foo.md': journal });
    expect(out1.agents.foo.status).toBe('done');
    // Second pass with the same journal — should produce the same state.
    const dir2 = mkdtempSync(join(tmpdir(), 'reconcile-test-'));
    tmpDirs.push(dir2);
    mkdirSync(join(dir2, 'agents'), { recursive: true });
    writeFileSync(join(dir2, 'agents', '_state.json'), JSON.stringify(out1));
    writeFileSync(join(dir2, 'agents', '2026-05-14-foo.md'), journal);
    const r = spawnSync('bash', ['-c', `cd "${dir2}" && STATE_FILE=agents/_state.json bash -c '. "${LIB}" && reconcile_state_from_journals'`], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    const out2 = JSON.parse(readFileSync(join(dir2, 'agents', '_state.json'), 'utf-8'));
    expect(out2.agents.foo).toEqual(out1.agents.foo);
  });

  // Issue #62: reconcile also searches agents/archive/ for journals.
  // After a completed plan's journal is moved to the archive directory,
  // reconcile must still find it (otherwise _state.json freezes at the
  // pre-archive values forever).
  it('finds journals that have been moved to agents/archive/ (issue #62)', () => {
    const state = {
      plans: {},
      agents: {
        archived: { status: 'in_progress', last_heartbeat: '2026-05-14T10:00:00Z' },
      },
    };
    const journal = buildJournal({ status: 'done', last_heartbeat: '2026-05-14T12:00:00Z' });

    // Place the journal in agents/archive/ instead of agents/
    const dir = mkdtempSync(join(tmpdir(), 'reconcile-archive-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'agents', 'archive'), { recursive: true });
    writeFileSync(join(dir, 'agents', '_state.json'), JSON.stringify(state));
    writeFileSync(join(dir, 'agents', 'archive', '2026-05-14-archived.md'), journal);

    const r = spawnSync('bash', ['-c', `cd "${dir}" && STATE_FILE=agents/_state.json bash -c '. "${LIB}" && reconcile_state_from_journals'`], { encoding: 'utf-8' });
    expect(r.status, `reconcile stderr=${r.stderr}`).toBe(0);

    const out = JSON.parse(readFileSync(join(dir, 'agents', '_state.json'), 'utf-8'));
    expect(out.agents.archived.status).toBe('done');
    expect(out.agents.archived.last_heartbeat).toBe('2026-05-14T12:00:00Z');
  });

  // Issue #61: composite single-write — when multiple journal fields change,
  // they should all apply atomically (asserted via a final consistent state).
  // The internal refactor changed N writes → 1 write per agent. Correctness
  // is exercised by the existing tests; this one specifically asserts that
  // when ALL 4 fields are present they're ALL set in the single composite.
  it('writes all 4 frontmatter fields in one composite update (issue #61)', () => {
    const state = {
      plans: {},
      agents: {
        full: {
          status: 'in_progress',
          last_heartbeat: '2026-05-14T10:00:00Z',
          checkpoint: 'pending',
        },
      },
    };
    const journal = buildJournal({
      status: 'done',
      last_heartbeat: '2026-05-14T13:00:00Z',
      checkpoint: 'pr-merged',
      pr_url: 'https://github.com/x/y/pull/99',
    });
    const out = runReconcile(state, { '2026-05-14-full.md': journal });
    expect(out.agents.full.status).toBe('done');
    expect(out.agents.full.last_heartbeat).toBe('2026-05-14T13:00:00Z');
    expect(out.agents.full.checkpoint).toBe('pr-merged');
    expect(out.agents.full.pr_url).toBe('https://github.com/x/y/pull/99');
  });
});
