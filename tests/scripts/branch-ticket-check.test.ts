import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/branch-ticket-check.sh');

function run(branch: string, env: Record<string, string> = {}, cwd?: string): { status: number; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, branch], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    cwd: cwd ?? REPO_ROOT,
  });
  return {
    status: result.status ?? 1,
    stderr: result.stderr ?? '',
  };
}

// Helper: create a tmp git repo with optional config files for the
// auto-discovery tests. Returns the repo path; caller cleans up.
function makeTmpRepo(opts: { coordPipelineJson?: object; jiraEnv?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'btc-test-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  if (opts.coordPipelineJson) {
    writeFileSync(join(dir, '.scrum-master.json'), JSON.stringify(opts.coordPipelineJson));
  }
  if (opts.jiraEnv !== undefined) {
    mkdirSync(join(dir, '.claude', 'jira'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'jira', '.env'), opts.jiraEnv);
  }
  return dir;
}

describe('scripts/branch-ticket-check.sh (a7)', () => {
  it('exits 0 on valid branch: feat/SCRUM-123-add-foo', () => {
    expect(run('feat/SCRUM-123-add-foo').status).toBe(0);
  });

  it('exits 0 on valid branch: fix/GH-99-bug', () => {
    expect(run('fix/GH-99-bug').status).toBe(0);
  });

  it('exits 0 on valid branch: plan/SCRUM-1-x', () => {
    expect(run('plan/SCRUM-1-x').status).toBe(0);
  });

  it('exits 0 on valid branch: chore/GH-2-y', () => {
    expect(run('chore/GH-2-y').status).toBe(0);
  });

  it('exits 0 on valid branch: design/SCRUM-3-z', () => {
    expect(run('design/SCRUM-3-z').status).toBe(0);
  });

  it('exits 0 on valid branch: docs/GH-4-a', () => {
    expect(run('docs/GH-4-a').status).toBe(0);
  });

  it('exits 0 on valid branch: test/SCRUM-5-b', () => {
    expect(run('test/SCRUM-5-b').status).toBe(0);
  });
});

describe('scripts/branch-ticket-check.sh (a9) — reject cases', () => {
  it('exits 1 on wrong prefix: feature/SCRUM-1-x', () => {
    const r = run('feature/SCRUM-1-x');
    expect(r.status).toBe(1);
    expect(r.stderr).toBeTruthy();
  });

  it('exits 1 on wrong key namespace: feat/JIRA-1-x', () => {
    const r = run('feat/JIRA-1-x');
    expect(r.status).toBe(1);
  });

  it('exits 1 on non-numeric ticket id: feat/SCRUM-x-y', () => {
    const r = run('feat/SCRUM-x-y');
    expect(r.status).toBe(1);
  });

  it('exits 1 on uppercase slug: feat/SCRUM-1-X', () => {
    const r = run('feat/SCRUM-1-X');
    expect(r.status).toBe(1);
  });

  it('exits 1 on missing slug: feat/SCRUM-1', () => {
    const r = run('feat/SCRUM-1');
    expect(r.status).toBe(1);
  });

  it('exits 1 on bare: main', () => {
    const r = run('main');
    expect(r.status).toBe(1);
  });

  it('exits 1 on empty string', () => {
    const r = run('');
    expect(r.status).toBe(1);
  });

  it('stderr message names the offending branch', () => {
    const r = run('feature/SCRUM-1-x');
    expect(r.stderr).toContain('feature/SCRUM-1-x');
  });
});

// Project-configurable regex (#43): the hardcoded SCRUM-/GH- pair broke
// every first-install on a non-SCRUM project. Project key is now resolved
// via (in priority order) JIRA_TICKET_PROJECT_KEY → JIRA_PROJECT →
// .claude/jira/.env's JIRA_PROJECT → .scrum-master.json's project
// field → SCRUM (legacy default).
describe('scripts/branch-ticket-check.sh — project-configurable regex (#43)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) {
      const d = tmpDirs.pop()!;
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('JIRA_TICKET_PROJECT_KEY env override accepts that prefix', () => {
    expect(run('feat/S20-1-foo', { JIRA_TICKET_PROJECT_KEY: 'S20' }).status).toBe(0);
    expect(run('feat/FOO-99-bar', { JIRA_TICKET_PROJECT_KEY: 'FOO' }).status).toBe(0);
  });

  it('JIRA_TICKET_PROJECT_KEY env override rejects the default SCRUM prefix', () => {
    const r = run('feat/SCRUM-1-foo', { JIRA_TICKET_PROJECT_KEY: 'S20' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('S20-[0-9]+');
  });

  it('GH- escape hatch still works under a non-SCRUM project override', () => {
    expect(run('fix/GH-42-bug', { JIRA_TICKET_PROJECT_KEY: 'S20' }).status).toBe(0);
  });

  it('JIRA_PROJECT env var (lower-priority than _KEY) is honored', () => {
    expect(run('feat/INGEST-7-pipe', { JIRA_PROJECT: 'INGEST' }).status).toBe(0);
    expect(run('feat/SCRUM-7-pipe', { JIRA_PROJECT: 'INGEST' }).status).toBe(1);
  });

  it('JIRA_TICKET_PROJECT_KEY overrides JIRA_PROJECT when both set', () => {
    // _KEY wins → S20 active → SCRUM rejected even though JIRA_PROJECT is SCRUM.
    expect(run('feat/S20-1-foo', { JIRA_TICKET_PROJECT_KEY: 'S20', JIRA_PROJECT: 'SCRUM' }).status).toBe(0);
    expect(run('feat/SCRUM-1-foo', { JIRA_TICKET_PROJECT_KEY: 'S20', JIRA_PROJECT: 'SCRUM' }).status).toBe(1);
  });

  it('auto-discovers JIRA_PROJECT from <repo>/.claude/jira/.env', () => {
    const dir = makeTmpRepo({ jiraEnv: 'JIRA_PROJECT=PHOENIX\nJIRA_EMAIL=a@b\n' });
    tmpDirs.push(dir);
    // Pass through env without _KEY/JIRA_PROJECT so the script must read the file.
    expect(run('feat/PHOENIX-1-up', { JIRA_TICKET_PROJECT_KEY: '', JIRA_PROJECT: '' }, dir).status).toBe(0);
    expect(run('feat/SCRUM-1-up',   { JIRA_TICKET_PROJECT_KEY: '', JIRA_PROJECT: '' }, dir).status).toBe(1);
  });

  it('auto-discovers jira_project from <repo>/.scrum-master.json (not .project, which is consumer name)', () => {
    // The `project` field in .scrum-master.json is the downstream
    // consumer name (e.g. "survaigo-ai"), not a Jira project key. Only the
    // explicit `jira_project` field is a valid project key. With only
    // `project` set, the resolver should fall through to SCRUM, not use it.
    const dir = makeTmpRepo({ coordPipelineJson: { plan_repo: 'org/plans', project: 'survaigo-ai' } });
    tmpDirs.push(dir);
    expect(run('feat/SCRUM-1-z',       { JIRA_TICKET_PROJECT_KEY: '', JIRA_PROJECT: '' }, dir).status).toBe(0);
    expect(run('feat/survaigo-ai-1-z', { JIRA_TICKET_PROJECT_KEY: '', JIRA_PROJECT: '' }, dir).status).toBe(1);

    // With `jira_project` set explicitly to a clean project key, it should be honored.
    rmSync(join(dir, '.scrum-master.json'));
    writeFileSync(join(dir, '.scrum-master.json'),
      JSON.stringify({ plan_repo: 'org/plans', project: 'survaigo-ai', jira_project: 'S20' }));
    expect(run('feat/S20-1-z',   { JIRA_TICKET_PROJECT_KEY: '', JIRA_PROJECT: '' }, dir).status).toBe(0);
    expect(run('feat/SCRUM-1-z', { JIRA_TICKET_PROJECT_KEY: '', JIRA_PROJECT: '' }, dir).status).toBe(1);
  });

  it('.claude/jira/.env takes precedence over .scrum-master.json', () => {
    const dir = makeTmpRepo({
      jiraEnv: 'JIRA_PROJECT=ENV_WINS\n',
      coordPipelineJson: { plan_repo: 'org/plans', project: 'consumer', jira_project: 'JSON_LOSES' },
    });
    tmpDirs.push(dir);
    expect(run('feat/ENV_WINS-1-a',   { JIRA_TICKET_PROJECT_KEY: '', JIRA_PROJECT: '' }, dir).status).toBe(0);
    expect(run('feat/JSON_LOSES-1-a', { JIRA_TICKET_PROJECT_KEY: '', JIRA_PROJECT: '' }, dir).status).toBe(1);
  });

  it('falls back to SCRUM when no env, no .env, no .scrum-master.json', () => {
    const dir = makeTmpRepo({});
    tmpDirs.push(dir);
    expect(run('feat/SCRUM-1-y', { JIRA_TICKET_PROJECT_KEY: '', JIRA_PROJECT: '' }, dir).status).toBe(0);
    expect(run('feat/FOO-1-y',   { JIRA_TICKET_PROJECT_KEY: '', JIRA_PROJECT: '' }, dir).status).toBe(1);
  });
});
