/**
 * a5: exponential backoff — 2-seed, 30-cap, 3 attempts.
 * Stub returns 503 twice then 200; helper succeeds on attempt 3.
 * Uses JIRA_BACKOFF_SEED_MS / JIRA_BACKOFF_CAP_MS env overrides for fast runtime.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPT = scriptPath('transition.sh');

describe('transition.sh — retry backoff (a5)', () => {
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

  it('succeeds on attempt 3 when stub returns 503 twice then 200', async () => {
    let getCallCount = 0;
    let postCallCount = 0;

    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-10/transitions', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transitions: [{ id: '21', name: 'In Development', to: { name: 'In Development' } }] }));
    });

    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-10', (_req, res) => {
      getCallCount++;
      // First GET: current state; subsequent GETs for verify
      const state = getCallCount === 1 ? 'Ready to Dev' : 'In Development';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: state } } }));
    });

    stub.setRoute('POST', '/rest/api/3/issue/SCRUM-10/transitions', (_req, res) => {
      postCallCount++;
      if (postCallCount <= 2) {
        // First two attempts: 503
        res.writeHead(503);
        res.end('Service Unavailable');
      } else {
        // Third attempt: success
        res.writeHead(204);
        res.end();
      }
    });

    const start = Date.now();
    const result = await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--ticket', 'SCRUM-10',
      '--to', 'In Development',
      '--reason', 'retry test'
    ], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: path.join(tmpDir, 'retry.json'),
      JIRA_BACKOFF_SEED_MS: '10',
      JIRA_BACKOFF_CAP_MS: '20'
    });
    const elapsed = Date.now() - start;

    expect(result.exitCode).toBe(0);
    expect(postCallCount).toBe(3);
    // At least 2 sleeps happened (seed=10ms each), under a few seconds total
    expect(elapsed).toBeGreaterThanOrEqual(10);
    expect(elapsed).toBeLessThan(5000);
  });
});
