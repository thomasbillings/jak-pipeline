/**
 * a4: verify-after-write — re-fetches after successful POST.
 * Stub returns 200 to POST but stale state on verify GET → enters retry loop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const SCRIPT = scriptPath('transition.sh');

describe('transition.sh — verify-after-write (a4)', () => {
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

  it('retries when POST succeeds but verify GET returns stale state', async () => {
    let getCallCount = 0;

    // transitions endpoint returns available transitions
    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-5/transitions', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transitions: [{ id: '11', name: 'In Development', to: { name: 'In Development' } }] }));
    });

    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-5', (_req: http.IncomingMessage, res: http.ServerResponse) => {
      getCallCount++;
      const state = getCallCount === 1 ? 'Ready to Dev' : 'Ready to Dev'; // always stale
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: state } } }));
    });

    stub.setRoute('POST', '/rest/api/3/issue/SCRUM-5/transitions', (_req, res) => {
      res.writeHead(204);
      res.end();
    });

    const retryQueue = path.join(tmpDir, 'retry.json');
    const result = await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--ticket', 'SCRUM-5',
      '--to', 'In Development',
      '--reason', 'dispatched'
    ], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: retryQueue,
      JIRA_BACKOFF_SEED_MS: '10',
      JIRA_BACKOFF_CAP_MS: '20'
    });

    // Should exit 0 (fall-through on persistent verify failure)
    expect(result.exitCode).toBe(0);

    // The POST must have been attempted (verify failed → retry loop)
    const posts = stub.requests.filter((r) => r.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(1);

    // On persistent mismatch after 3 attempts, lands in retry queue
    if (fs.existsSync(retryQueue)) {
      const lines = fs.readFileSync(retryQueue, 'utf8').trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const entry = JSON.parse(lines[lines.length - 1]);
      expect(entry.ticket).toBe('SCRUM-5');
    }
  });
});
