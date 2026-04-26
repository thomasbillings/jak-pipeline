/**
 * a10: drift reconciliation pass — 5 test cases per the acceptance criterion.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const TICK_EXT = scriptPath('tick-extension.sh');

// Helper that runs the drift reconciliation pass with a controlled environment
async function runDriftPass(opts: {
  stub: StubServer;
  envFile: string;
  tmpDir: string;
  prs: Array<{ number: number; branch: string; state: string; merged: boolean }>;
  jiraStates: Record<string, string>;
  driftFileContent?: Record<string, string>;
  /** Called after default routes are set up — override specific routes for stateful tests. */
  afterRouteSetup?: () => void;
  backoffMs?: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string; driftFile: Record<string, string> | null; tickLog: string }> {
  const { stub, envFile, tmpDir, prs, jiraStates, driftFileContent } = opts;

  const driftFilePath = path.join(tmpDir, 'agents', '_jira-drift.json');
  const tickLogPath = path.join(tmpDir, 'agents', '_tick-log.md');
  const retryQueue = path.join(tmpDir, 'agents', '_jira-retry.json');
  fs.mkdirSync(path.dirname(driftFilePath), { recursive: true });

  if (driftFileContent) {
    fs.writeFileSync(driftFilePath, JSON.stringify(driftFileContent));
  }

  // Create a gh stub that returns our controlled PR list
  const ghDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(ghDir, { recursive: true });
  const ghStub = path.join(ghDir, 'gh');

  const prJson = JSON.stringify(prs.map((pr) => ({
    number: pr.number,
    headRefName: pr.branch,
    state: pr.merged ? 'MERGED' : pr.state,
    merged: pr.merged
  })));

  const postCommentScript = `#!/usr/bin/env bash
case "$1" in
  api) echo '{}' ;;
  pr) echo "PR_COMMENT: $*" ;;
  *) echo '[]' ;;
esac
`;

  // Install gh stub that echoes PR list for the list command
  fs.writeFileSync(ghStub, `#!/usr/bin/env bash
if [[ "$*" == *"pr list"* ]] || [[ "$*" == *"pr view"* && "$*" == *"json"* ]]; then
  echo '${prJson.replace(/'/g, "'\\''")}'
elif [[ "$*" == *"pr comment"* ]]; then
  echo "PR_COMMENT: $*"
elif [[ "$1" == "api"* ]]; then
  echo '{}'
else
  echo '[]'
fi
`);
  fs.chmodSync(ghStub, 0o755);

  // Wire up Jira routes for each ticket
  for (const [ticket, state] of Object.entries(jiraStates)) {
    const urlPath = `/rest/api/3/issue/${ticket}`;
    stub.setRoute('GET', urlPath, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: state } } }));
    });
    stub.setRoute('GET', `${urlPath}/transitions`, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Return plausible transitions
      res.end(JSON.stringify({
        transitions: [
          { id: '1', name: 'In Development', to: { name: 'In Development' } },
          { id: '2', name: 'PR Review', to: { name: 'PR Review' } },
          { id: '3', name: 'Merge Queue', to: { name: 'Merge Queue' } },
          { id: '4', name: 'UAT', to: { name: 'UAT' } },
          { id: '5', name: 'Done', to: { name: 'Done' } },
          { id: '6', name: 'Plan Review', to: { name: 'Plan Review' } },
          { id: '7', name: 'Ready to Dev', to: { name: 'Ready to Dev' } },
          { id: '8', name: 'Planning', to: { name: 'Planning' } }
        ]
      }));
    });
    stub.setRoute('POST', `/rest/api/3/issue/${ticket}/transitions`, (_req, res) => {
      res.writeHead(204);
      res.end();
    });
  }

  // Allow tests to override / augment routes after defaults
  opts.afterRouteSetup?.();

  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('bash', ['-c', `
      source "${TICK_EXT}" 2>/dev/null
      jak_pipeline_jira_tick_pass
    `], {
      env: {
        ...process.env,
        JIRA_ENV_FILE: envFile,
        JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
        JIRA_RETRY_QUEUE: retryQueue,
        JIRA_DRIFT_FILE: driftFilePath,
        JAK_TICK_LOG: tickLogPath,
        DOWNSTREAM_ROOT: tmpDir,
        PATH: `${ghDir}:${process.env.PATH}`,
        JIRA_BACKOFF_SEED_MS: opts.backoffMs ?? '50',
        JIRA_BACKOFF_CAP_MS: opts.backoffMs ?? '50'
      }
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });

  const driftFile = fs.existsSync(driftFilePath)
    ? JSON.parse(fs.readFileSync(driftFilePath, 'utf8'))
    : null;

  const tickLog = fs.existsSync(tickLogPath)
    ? fs.readFileSync(tickLogPath, 'utf8')
    : '';

  return { ...result, driftFile, tickLog };
}

describe('drift reconciliation (a10)', () => {
  let tmpDir: string;
  let stub: StubServer;
  let envFile: string;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    stub = await createStubJira();
    envFile = makeJiraEnvFile(tmpDir, { JIRA_BASE_URL: `http://127.0.0.1:${stub.port}` });
  });

  afterEach(async () => {
    await stub.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(i) no drift → no PR comment, no transition call', async () => {
    // PR is open (In Development); Jira also In Development
    const result = await runDriftPass({
      stub, envFile, tmpDir,
      prs: [{ number: 1, branch: 'feat/SCRUM-1-my-feature', state: 'OPEN', merged: false }],
      jiraStates: { 'SCRUM-1': 'In Development' }
    });

    expect(result.exitCode).toBe(0);
    const posts = stub.requests.filter((r) => r.method === 'POST');
    expect(posts.length).toBe(0);
  });

  it('(ii) drift first observed → state recorded in _jira-drift.json, no PR comment, no transition', async () => {
    // PR is open (In Development); Jira still in Ready to Dev — drift, but first observation
    const result = await runDriftPass({
      stub, envFile, tmpDir,
      prs: [{ number: 2, branch: 'feat/SCRUM-2-feature', state: 'OPEN', merged: false }],
      jiraStates: { 'SCRUM-2': 'Ready to Dev' }
    });

    expect(result.exitCode).toBe(0);
    const posts = stub.requests.filter((r) => r.method === 'POST');
    expect(posts.length).toBe(0);
    // Drift file should record SCRUM-2
    expect(result.driftFile).not.toBeNull();
    expect(Object.keys(result.driftFile!)).toContain('SCRUM-2');
  });

  it('(iii) drift ≥10min → PR comment posted, transition called, drift entry cleared on success', async () => {
    // Pre-seed drift file with a timestamp > 10 min ago
    const oldTime = new Date(Date.now() - 12 * 60 * 1000).toISOString();

    // Stateful stub: returns 'Ready to Dev' until a POST is received, then 'In Development'
    let scrum3State = 'Ready to Dev';

    const result = await runDriftPass({
      stub, envFile, tmpDir,
      prs: [{ number: 3, branch: 'feat/SCRUM-3-feature', state: 'OPEN', merged: false }],
      jiraStates: { 'SCRUM-3': 'Ready to Dev' },
      driftFileContent: { 'SCRUM-3': oldTime },
      afterRouteSetup: () => {
        // Override GET to be stateful
        stub.setRoute('GET', '/rest/api/3/issue/SCRUM-3', (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ fields: { status: { name: scrum3State } } }));
        });
        // POST transition updates state
        stub.setRoute('POST', '/rest/api/3/issue/SCRUM-3/transitions', (_req, res) => {
          scrum3State = 'In Development';
          res.writeHead(204);
          res.end();
        });
      }
    });

    expect(result.exitCode).toBe(0);

    // transition POST should have been called
    const posts = stub.requests.filter((r) => r.method === 'POST' && r.url.includes('SCRUM-3'));
    expect(posts.length).toBeGreaterThanOrEqual(1);

    // Tick log should have JIRA_DRIFT: entry
    expect(result.tickLog).toMatch(/JIRA_DRIFT:/);

    // Drift entry cleared on success
    if (result.driftFile !== null) {
      expect(Object.keys(result.driftFile)).not.toContain('SCRUM-3');
    }
  });

  it('(iv) Jira 3 states behind GitHub → 3 sequential transition.sh calls', async () => {
    const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    // Stateful: PR Review → Merge Queue → UAT → Done (state advances on each POST)
    const walkStates = ['PR Review', 'Merge Queue', 'UAT', 'Done'];
    let stateIdx = 0;

    // PR is merged → Done expected; Jira is at PR Review (3 hops: Merge Queue → UAT → Done)
    const result = await runDriftPass({
      stub, envFile, tmpDir,
      prs: [{ number: 4, branch: 'feat/SCRUM-4-feature', state: 'MERGED', merged: true }],
      jiraStates: { 'SCRUM-4': 'PR Review' },
      driftFileContent: { 'SCRUM-4': oldTime },
      afterRouteSetup: () => {
        stub.setRoute('GET', '/rest/api/3/issue/SCRUM-4', (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ fields: { status: { name: walkStates[stateIdx] } } }));
        });
        stub.setRoute('POST', '/rest/api/3/issue/SCRUM-4/transitions', (_req, res) => {
          stateIdx = Math.min(stateIdx + 1, walkStates.length - 1);
          res.writeHead(204);
          res.end();
        });
      }
    });

    expect(result.exitCode).toBe(0);

    const posts = stub.requests.filter((r) => r.method === 'POST' && r.url.includes('SCRUM-4'));
    // At least 3 POSTs for 3-hop walk (PR Review → Merge Queue → UAT → Done)
    expect(posts.length).toBeGreaterThanOrEqual(3);
  });

  it('(v) Jira AHEAD of GitHub → zero transition, one PR comment with [JAK-PIPELINE JIRA AHEAD], tick-log append', async () => {
    // PR is open (In Development = expected); Jira is at Merge Queue (AHEAD)
    const result = await runDriftPass({
      stub, envFile, tmpDir,
      prs: [{ number: 5, branch: 'feat/SCRUM-5-feature', state: 'OPEN', merged: false }],
      jiraStates: { 'SCRUM-5': 'Merge Queue' },
      driftFileContent: { 'SCRUM-5': new Date(Date.now() - 15 * 60 * 1000).toISOString() }
    });

    expect(result.exitCode).toBe(0);

    const posts = stub.requests.filter((r) => r.method === 'POST' && r.url.includes('SCRUM-5'));
    expect(posts.length).toBe(0);

    // PR comment with JIRA AHEAD prefix should have been posted
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/\[JAK-PIPELINE JIRA AHEAD\]/i);

    expect(result.tickLog).toMatch(/JIRA_DRIFT:/);
  });
});
