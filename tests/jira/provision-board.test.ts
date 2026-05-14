/**
 * provision-board.sh — idempotent Jira workflow provisioning (issue #23).
 *
 * Rewrites the legacy board-column-POST tests against the modern
 * /rest/api/3/workflows/create + /workflowscheme/project/switch flow.
 *
 * Live empirical artifacts that informed these stubs live in
 * /tmp/jak-workflow-{payload,create-response,validate}.json,
 * /tmp/scheme-create-response.json, and /tmp/switch-payload.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createStubJira,
  runScript,
  scriptPath,
  makeTempDir,
  makeJiraEnvFile,
  type StubServer,
} from './_stub-jira.ts';
import * as fs from 'node:fs';

const SCRIPT = scriptPath('provision-board.sh');

const CANONICAL_STATES = [
  'Idea', 'Backlog', 'Planning', 'Plan Review', 'Ready to Dev',
  'In Development', 'PR Review', 'Merge Queue', 'UAT', 'Done',
  'Blocked', 'Cancelled',
];

interface StubOpts {
  adminGranted?: boolean;
  projectStatus?: number;
  projectStyle?: string;
  simplified?: boolean;
  currentDefaultWorkflow?: string;
  presentStatuses?: string[];
  validateErrors?: unknown[];
  validateWarnings?: unknown[];
  createStatus?: number;
  schemeStatus?: number;
  schemeId?: string;
  switchStatus?: number;
  switchBody?: object | string;
  taskSequence?: string[]; // returned in order on successive GETs
  globalSearchHits?: Record<string, string>; // name -> id
}

function wireStub(stub: StubServer, projectKey: string, projectId: string, opts: StubOpts = {}): void {
  stub.setDefaultResponse(200, '{}');

  stub.setRoute('GET', '/rest/api/3/mypermissions?permissions=ADMINISTER', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      permissions: { ADMINISTER: { havePermission: opts.adminGranted ?? true } },
    }));
  });

  stub.setRoute('GET', `/rest/api/3/project/${projectKey}`, (_req, res) => {
    const code = opts.projectStatus ?? 200;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    if (code !== 200) {
      res.end(JSON.stringify({ errorMessages: ['Not found'] }));
      return;
    }
    res.end(JSON.stringify({
      id: projectId,
      key: projectKey,
      style: opts.projectStyle ?? 'classic',
      simplified: opts.simplified ?? false,
    }));
  });

  stub.setRoute('GET', `/rest/api/3/workflowscheme/project?projectId=${projectId}`, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      values: [{
        projectIds: [projectId],
        workflowScheme: {
          id: 9999,
          name: opts.currentDefaultWorkflow === 'jak-pipeline' ? 'jak-pipeline scheme' : 'Default Workflow Scheme',
          defaultWorkflow: opts.currentDefaultWorkflow ?? 'classic default workflow',
        },
      }],
    }));
  });

  stub.setRoute('GET', `/rest/api/3/project/${projectKey}/statuses`, (_req, res) => {
    const names = opts.presentStatuses ?? ['To Do', 'In Progress', 'Done'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(names.length === 0 ? [] : [
      {
        id: '10007',
        name: 'Story',
        statuses: names.map((n, i) => ({
          id: `${10300 + i}`,
          name: n,
          statusCategory: { key: n === 'Done' ? 'done' : (n.toLowerCase().includes('progress') ? 'indeterminate' : 'new') },
        })),
      },
    ]));
  });

  // Per-status searches (one per KANBAN_STATE). Default = no hits.
  for (const state of CANONICAL_STATES) {
    const encoded = encodeURIComponent(state);
    stub.setRoute('GET', `/rest/api/3/statuses/search?searchString=${encoded}`, (_req, res) => {
      const hit = opts.globalSearchHits?.[state];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        values: hit ? [{ id: hit, name: state, scope: { type: 'GLOBAL' } }] : [],
      }));
    });
  }

  stub.setRoute('POST', '/rest/api/3/workflows/create/validation', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      errors: opts.validateErrors ?? [],
      warnings: opts.validateWarnings ?? [],
    }));
  });

  stub.setRoute('POST', '/rest/api/3/workflows/create', (_req, res) => {
    res.writeHead(opts.createStatus ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ statuses: [], workflows: [{ id: 'wf-jak', name: 'jak-pipeline' }] }));
  });

  stub.setRoute('POST', '/rest/api/3/workflowscheme', (_req, res) => {
    res.writeHead(opts.schemeStatus ?? 201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: opts.schemeId ?? '10168', name: 'jak-pipeline scheme' }));
  });

  stub.setRoute('POST', '/rest/api/3/workflowscheme/project/switch', (_req, res) => {
    res.writeHead(opts.switchStatus ?? 303, { 'Content-Type': 'application/json' });
    const body = typeof opts.switchBody === 'string'
      ? opts.switchBody
      : JSON.stringify(opts.switchBody ?? { taskId: 'task-42' });
    res.end(body);
  });

  let taskCallIdx = 0;
  stub.setRoute('GET', '/rest/api/3/task/task-42', (_req, res) => {
    const seq = opts.taskSequence ?? ['COMPLETE'];
    const status = seq[Math.min(taskCallIdx, seq.length - 1)];
    taskCallIdx++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status }));
  });
}

describe('provision-board.sh — workflow-API provisioning (issue #23)', () => {
  let tmpDir: string;
  let stub: StubServer;
  let envFile: string;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    stub = await createStubJira();
    envFile = makeJiraEnvFile(tmpDir, {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
    });
  });

  afterEach(async () => {
    await stub.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  it('provisions workflow + scheme + switch on a fresh classic project', async () => {
    wireStub(stub, 'SCRUM', '10166');

    const result = await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(0);

    const posts = stub.requests.filter((r) => r.method === 'POST');
    expect(posts.find((r) => r.url === '/rest/api/3/workflows/create/validation')).toBeDefined();
    expect(posts.find((r) => r.url === '/rest/api/3/workflows/create')).toBeDefined();
    expect(posts.find((r) => r.url === '/rest/api/3/workflowscheme')).toBeDefined();
    expect(posts.find((r) => r.url === '/rest/api/3/workflowscheme/project/switch')).toBeDefined();
  });

  it('validate payload wraps the workflow with validationOptions levels', async () => {
    wireStub(stub, 'SCRUM', '10166');

    await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    const validatePost = stub.requests.find(
      (r) => r.method === 'POST' && r.url === '/rest/api/3/workflows/create/validation'
    );
    const body = JSON.parse(validatePost!.body);
    expect(body.payload).toBeDefined();
    expect(body.validationOptions.levels).toContain('ERROR');
    expect(body.validationOptions.levels).toContain('WARNING');
  });

  it('create payload has 12 statuses, GLOBAL scope, INITIAL+12 GLOBAL transitions, links:[] on every transition', async () => {
    wireStub(stub, 'SCRUM', '10166');

    await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    const createPost = stub.requests.find(
      (r) => r.method === 'POST' && r.url === '/rest/api/3/workflows/create'
    );
    const payload = JSON.parse(createPost!.body);

    expect(payload.scope.type).toBe('GLOBAL');
    expect(payload.statuses.length).toBe(12);
    expect(payload.statuses.map((s: { name: string }) => s.name).sort()).toEqual([...CANONICAL_STATES].sort());

    for (const s of payload.statuses) {
      expect(s.statusReference).toMatch(/^[0-9a-f-]{36}$/);
    }

    const wf = payload.workflows[0];
    expect(wf.name).toBe('jak-pipeline');
    expect(wf.transitions.length).toBe(13); // 1 INITIAL + 12 GLOBAL

    const initial = wf.transitions.find((t: { type: string }) => t.type === 'INITIAL');
    expect(initial).toBeDefined();
    expect(initial.name).toBe('Create');

    for (const t of wf.transitions) {
      expect(Array.isArray(t.links)).toBe(true);
    }
  });

  it('reuses pre-existing GLOBAL statuses by id (avoids NON_UNIQUE_STATUS_NAME)', async () => {
    wireStub(stub, 'SCRUM', '10166', {
      globalSearchHits: { Backlog: '10033', Done: '10035' },
    });

    await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    const createPost = stub.requests.find(
      (r) => r.method === 'POST' && r.url === '/rest/api/3/workflows/create'
    );
    const payload = JSON.parse(createPost!.body);
    const byName: Record<string, { id?: string }> = {};
    for (const s of payload.statuses) byName[s.name] = s;

    expect(byName.Backlog.id).toBe('10033');
    expect(byName.Done.id).toBe('10035');
    expect(byName.Idea.id).toBeUndefined();
    expect(byName.Cancelled.id).toBeUndefined();
  });

  it('switch payload uses targetSchemeId (not workflowSchemeId) and mappingsByIssueTypeOverride', async () => {
    wireStub(stub, 'SCRUM', '10166', {
      presentStatuses: ['To Do', 'In Progress', 'Done'],
    });

    await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    const switchPost = stub.requests.find(
      (r) => r.method === 'POST' && r.url === '/rest/api/3/workflowscheme/project/switch'
    );
    const payload = JSON.parse(switchPost!.body);

    expect(payload.targetSchemeId).toBe('10168');
    expect(payload.projectId).toBe('10166');
    expect(Array.isArray(payload.mappingsByIssueTypeOverride)).toBe(true);
    expect(payload.workflowSchemeId).toBeUndefined();
  });

  // ─── Idempotency ──────────────────────────────────────────────────────────

  it('no-ops (no POST/PUT writes) when project already has jak-pipeline scheme + all 12 statuses', async () => {
    wireStub(stub, 'SCRUM', '10166', {
      currentDefaultWorkflow: 'jak-pipeline',
      presentStatuses: CANONICAL_STATES,
    });

    const result = await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/already provisioned/);

    const writes = stub.requests.filter((r) => r.method === 'POST' || r.method === 'PUT' || r.method === 'DELETE');
    expect(writes.length).toBe(0);
  });

  it('re-provisions when defaultWorkflow=jak-pipeline but some statuses missing (drift)', async () => {
    wireStub(stub, 'SCRUM', '10166', {
      currentDefaultWorkflow: 'jak-pipeline',
      presentStatuses: CANONICAL_STATES.slice(0, 6),
    });

    const result = await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/will re-provision/);

    const create = stub.requests.find(
      (r) => r.method === 'POST' && r.url === '/rest/api/3/workflows/create'
    );
    expect(create).toBeDefined();
  });

  // ─── Pre-flight errors ────────────────────────────────────────────────────

  it('exits 1 when Jira admin permission missing', async () => {
    wireStub(stub, 'SCRUM', '10166', { adminGranted: false });

    const result = await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/admin permission required/i);

    const create = stub.requests.find(
      (r) => r.method === 'POST' && r.url === '/rest/api/3/workflows/create'
    );
    expect(create).toBeUndefined();
  });

  it('exits 2 when project is team-managed (simplified)', async () => {
    wireStub(stub, 'SCRUM', '10166', { simplified: true, projectStyle: 'next-gen' });

    const result = await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/team-managed|company-managed/i);
  });

  it('exits 1 when project not found', async () => {
    wireStub(stub, 'SCRUM', '10166', { projectStatus: 404 });

    const result = await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not found/i);
  });

  // ─── Mid-flow errors ──────────────────────────────────────────────────────

  it('exits 1 when validation returns errors[] (does not proceed to create)', async () => {
    wireStub(stub, 'SCRUM', '10166', {
      validateErrors: [{ code: 'STATUS_REFERENCE_NOT_UUID', message: 'invalid ref' }],
    });

    const result = await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/validation reported.*error/i);

    const create = stub.requests.find(
      (r) => r.method === 'POST' && r.url === '/rest/api/3/workflows/create'
    );
    expect(create).toBeUndefined();
  });

  it('exits 1 on switch 409 conflictingTaskId with retry hint', async () => {
    wireStub(stub, 'SCRUM', '10166', {
      switchStatus: 409,
      switchBody: { errorMessages: ['conflictingTaskId'], conflictingTaskId: 'task-99' },
    });

    const result = await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/conflictingTaskId|in progress/i);
  });

  it('polls task endpoint after 303 + succeeds when COMPLETE', async () => {
    wireStub(stub, 'SCRUM', '10166', {
      switchStatus: 303,
      switchBody: { taskId: 'task-42' },
      taskSequence: ['ENQUEUED', 'RUNNING', 'COMPLETE'],
    });

    const result = await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(0);

    const taskGets = stub.requests.filter(
      (r) => r.method === 'GET' && r.url === '/rest/api/3/task/task-42'
    );
    expect(taskGets.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('exits 1 when async task ends FAILED', async () => {
    wireStub(stub, 'SCRUM', '10166', {
      switchStatus: 303,
      switchBody: { taskId: 'task-42' },
      taskSequence: ['RUNNING', 'FAILED'],
    });

    const result = await runScript(SCRIPT, ['--project', 'SCRUM'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/task ended with status=FAILED/);
  }, 30_000);

  // ─── CLI ──────────────────────────────────────────────────────────────────

  it('--board flag is deprecated: emits warning but does not fail', async () => {
    wireStub(stub, 'SCRUM', '10166', {
      currentDefaultWorkflow: 'jak-pipeline',
      presentStatuses: CANONICAL_STATES,
    });

    const result = await runScript(SCRIPT, ['--project', 'SCRUM', '--board', '42'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/--board.*deprecated/i);
  });

  it('exits 1 when --project missing', async () => {
    const result = await runScript(SCRIPT, [], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/--project is required/i);
  });
});
