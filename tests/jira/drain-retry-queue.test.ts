/**
 * a8: drain-retry-queue.sh — drains _jira-retry.json row-by-row.
 * Covers: empty queue, partial success, flock contention safety.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPT = scriptPath('drain-retry-queue.sh');

function makeRow(ticket: string, targetState: string, attemptCount = 1): string {
  return JSON.stringify({
    project: 'SCRUM',
    ticket,
    target_state: targetState,
    reason: 'test',
    first_attempted_at: new Date().toISOString(),
    last_attempted_at: new Date().toISOString(),
    attempt_count: attemptCount,
    last_error: 'HTTP 503'
  });
}

describe('drain-retry-queue.sh (a8)', () => {
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

  it('exits 0 on empty / missing queue (no-op)', async () => {
    const retryQueue = path.join(tmpDir, 'retry.json');

    const result = await runScript(SCRIPT, [], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: retryQueue,
      DOWNSTREAM_ROOT: tmpDir
    });

    expect(result.exitCode).toBe(0);
  });

  it('removes successful rows and leaves failed rows with incremented attempt_count', async () => {
    // Row 1: SCRUM-1 → will succeed
    // Row 2: SCRUM-2 → will always fail (503)
    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-1', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: 'Ready to Dev' } } }));
    });

    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-1/transitions', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transitions: [{ id: '10', name: 'In Development', to: { name: 'In Development' } }] }));
    });

    stub.setRoute('POST', '/rest/api/3/issue/SCRUM-1/transitions', (_req, res) => {
      res.writeHead(204);
      res.end();
    });

    // verify GET for SCRUM-1
    let scrum1GetCount = 0;
    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-1', (_req, res) => {
      scrum1GetCount++;
      const state = scrum1GetCount >= 2 ? 'In Development' : 'Ready to Dev';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: state } } }));
    });

    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-2/transitions', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transitions: [{ id: '11', name: 'PR Review', to: { name: 'PR Review' } }] }));
    });

    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-2', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: 'In Development' } } }));
    });

    stub.setRoute('POST', '/rest/api/3/issue/SCRUM-2/transitions', (_req, res) => {
      res.writeHead(503);
      res.end('Service Unavailable');
    });

    const retryQueue = path.join(tmpDir, 'retry.json');
    fs.writeFileSync(retryQueue,
      makeRow('SCRUM-1', 'In Development', 1) + '\n' +
      makeRow('SCRUM-2', 'PR Review', 1) + '\n'
    );

    const result = await runScript(SCRIPT, [], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: retryQueue,
      JIRA_BACKOFF_SEED_MS: '10',
      JIRA_BACKOFF_CAP_MS: '20',
      DOWNSTREAM_ROOT: tmpDir
    });

    expect(result.exitCode).toBe(0);

    const remaining = fs.readFileSync(retryQueue, 'utf8').trim().split('\n').filter(Boolean);
    expect(remaining.length).toBe(1);

    const failedRow = JSON.parse(remaining[0]);
    expect(failedRow.ticket).toBe('SCRUM-2');
    expect(failedRow.attempt_count).toBeGreaterThanOrEqual(2);
  });

  it('queue file is not corrupted under simulated concurrency (flock)', async () => {
    const retryQueue = path.join(tmpDir, 'retry.json');
    fs.writeFileSync(retryQueue, makeRow('SCRUM-3', 'Done', 1) + '\n');

    // Run two drain instances concurrently
    const [r1, r2] = await Promise.all([
      runScript(SCRIPT, [], {
        JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
        JIRA_ENV_FILE: envFile,
        JIRA_RETRY_QUEUE: retryQueue,
        JIRA_BACKOFF_SEED_MS: '10',
        JIRA_BACKOFF_CAP_MS: '20',
        DOWNSTREAM_ROOT: tmpDir
      }),
      runScript(SCRIPT, [], {
        JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
        JIRA_ENV_FILE: envFile,
        JIRA_RETRY_QUEUE: retryQueue,
        JIRA_BACKOFF_SEED_MS: '10',
        JIRA_BACKOFF_CAP_MS: '20',
        DOWNSTREAM_ROOT: tmpDir
      })
    ]);

    // Both should exit 0
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);

    // Queue file should still be valid (parseable), not corrupted
    if (fs.existsSync(retryQueue)) {
      const content = fs.readFileSync(retryQueue, 'utf8');
      for (const line of content.trim().split('\n').filter(Boolean)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });
});
