/**
 * Regression test for the "Move to <STATE>" transition lookup bug.
 *
 * History: transition.sh previously tried a bash grep fast-path that scanned
 * the transitions JSON for `"name":"${TARGET_STATE}"`, took the line before,
 * and extracted the first `"id":"X"` with a greedy sed regex. Jira returns
 * the transitions list on a single line of JSON, so `grep -B1` was a no-op
 * and the greedy regex captured the LAST quoted `"id"` on the line — which
 * was the destination status's `to.id`, not the transition's own `id`.
 *
 * The bug was invisible to tests because the existing stubs returned
 * `to: { name: 'X' }` with no `to.id` field. Against real Jira (which always
 * includes `to.id`), every transition lookup against a workflow whose
 * transition names didn't match their destination status names (e.g. the
 * canonical "Move to <STATE>" convention) routed to the wrong endpoint and
 * got HTTP 400.
 *
 * This test reproduces the real-Jira shape: every `to` object has its own
 * `id`, and every transition `name` differs from `to.name`. The script must
 * route to the transition's own `id`, not `to.id`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPT = scriptPath('transition.sh');

// jak-pipeline's canonical 12-state workflow: transition `name` is "Move to X",
// destination status `to.name` is "X", and each `to` has its own status `id`.
const JAK_TRANSITIONS = [
  { id: '11', name: 'Move to Idea',           to: { id: '10201', name: 'Idea' } },
  { id: '12', name: 'Move to Backlog',        to: { id: '10033', name: 'Backlog' } },
  { id: '13', name: 'Move to Planning',       to: { id: '10202', name: 'Planning' } },
  { id: '14', name: 'Move to Plan Review',    to: { id: '10203', name: 'Plan Review' } },
  { id: '15', name: 'Move to Ready to Dev',   to: { id: '10204', name: 'Ready to Dev' } },
  { id: '16', name: 'Move to In Development', to: { id: '10205', name: 'In Development' } },
  { id: '17', name: 'Move to PR Review',      to: { id: '10206', name: 'PR Review' } },
  { id: '18', name: 'Move to Merge Queue',    to: { id: '10207', name: 'Merge Queue' } },
  { id: '19', name: 'Move to UAT',            to: { id: '10208', name: 'UAT' } },
  { id: '20', name: 'Move to Done',           to: { id: '10035', name: 'Done' } },
  { id: '21', name: 'Move to Blocked',        to: { id: '10133', name: 'Blocked' } },
  { id: '22', name: 'Move to Cancelled',      to: { id: '10209', name: 'Cancelled' } },
];

// Helper: wire a stateful GET-issue route whose response flips from `from`
// to `to` after the first call. The script GETs the issue twice — once to
// read current state, once to verify after POST.
function setStatefulIssueState(stub: StubServer, ticketPath: string, from: string, to: string) {
  let calls = 0;
  stub.setRoute('GET', ticketPath, (_req, res) => {
    calls++;
    const name = calls === 1 ? from : to;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ fields: { status: { name } } }));
  });
}

describe('transition.sh — destination-status lookup (regression)', () => {
  let tmpDir: string;
  let stub: StubServer;
  let envFile: string;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    stub = await createStubJira();
    envFile = makeJiraEnvFile(tmpDir, { JIRA_BASE_URL: `http://127.0.0.1:${stub.port}` });

    // Available transitions reflect the full jak-pipeline workflow.
    stub.setRoute('GET', '/rest/api/3/issue/S20-1/transitions', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transitions: JAK_TRANSITIONS }));
    });

    // POST succeeds.
    stub.setRoute('POST', '/rest/api/3/issue/S20-1/transitions', (_req, res) => {
      res.writeHead(204);
      res.end();
    });
  });

  afterEach(async () => {
    await stub.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes "Move to Planning" → transition.id 13, not status.id 10202', async () => {
    setStatefulIssueState(stub, '/rest/api/3/issue/S20-1', 'Backlog', 'Planning');

    const result = await runScript(SCRIPT, [
      '--project', 'S20',
      '--ticket', 'S20-1',
      '--to', 'Planning',
      '--reason', 'regression test'
    ], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: path.join(tmpDir, 'retry.json')
    });

    expect(result.exitCode).toBe(0);

    const posts = stub.requests.filter((r) => r.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(1);

    const body = JSON.parse(posts[0].body);
    // Must be the TRANSITION id (13), not the destination status id (10202).
    expect(body).toEqual({ transition: { id: '13' } });
  });

  it('routes "Move to In Development" → transition.id 16, not status.id 10205', async () => {
    setStatefulIssueState(stub, '/rest/api/3/issue/S20-1', 'Backlog', 'In Development');

    const result = await runScript(SCRIPT, [
      '--project', 'S20',
      '--ticket', 'S20-1',
      '--to', 'In Development',
      '--reason', 'regression test'
    ], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: path.join(tmpDir, 'retry.json')
    });

    expect(result.exitCode).toBe(0);
    const posts = stub.requests.filter((r) => r.method === 'POST');
    const body = JSON.parse(posts[0].body);
    expect(body).toEqual({ transition: { id: '16' } });
  });

  it('still matches when transition.name happens to equal target (TnT-style naming)', async () => {
    // Some workflows name the transition the same as the destination status
    // (e.g. "In Development" → "In Development"). Both naming conventions
    // must keep working — the python parser checks both `name` and `to.name`.
    const TNT_TRANSITIONS = [
      { id: '21', name: 'In Development', to: { id: '10205', name: 'In Development' } },
      { id: '22', name: 'Done',           to: { id: '10035', name: 'Done' } },
    ];
    stub.setRoute('GET', '/rest/api/3/issue/S20-1/transitions', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transitions: TNT_TRANSITIONS }));
    });
    setStatefulIssueState(stub, '/rest/api/3/issue/S20-1', 'Ready to Dev', 'In Development');

    const result = await runScript(SCRIPT, [
      '--project', 'S20',
      '--ticket', 'S20-1',
      '--to', 'In Development',
      '--reason', 'TnT-style'
    ], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: path.join(tmpDir, 'retry.json')
    });

    expect(result.exitCode).toBe(0);
    const posts = stub.requests.filter((r) => r.method === 'POST');
    const body = JSON.parse(posts[0].body);
    expect(body).toEqual({ transition: { id: '21' } });
  });
});
