/**
 * a6: fall-through to retry queue — stub returns 503 forever.
 * After 3 failed attempts, appends a JSONL row to _jira-retry.json and exits 0.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPT = scriptPath('transition.sh');

describe('transition.sh — fall-through to retry queue (a6)', () => {
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

  it('exits 0 and appends JSONL row when stub always returns 503', async () => {
    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-99/transitions', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transitions: [{ id: '5', name: 'PR Review', to: { name: 'PR Review' } }] }));
    });

    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-99', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: 'In Development' } } }));
    });

    // Always 503
    stub.setRoute('POST', '/rest/api/3/issue/SCRUM-99/transitions', (_req, res) => {
      res.writeHead(503);
      res.end('Service Unavailable');
    });

    const retryQueue = path.join(tmpDir, 'retry.json');
    const result = await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--ticket', 'SCRUM-99',
      '--to', 'PR Review',
      '--reason', 'pr-opened'
    ], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: retryQueue,
      JIRA_BACKOFF_SEED_MS: '10',
      JIRA_BACKOFF_CAP_MS: '20'
    });

    expect(result.exitCode).toBe(0);

    // Queue file should exist
    expect(fs.existsSync(retryQueue)).toBe(true);

    const lines = fs.readFileSync(retryQueue, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.project).toBe('SCRUM');
    expect(entry.ticket).toBe('SCRUM-99');
    expect(entry.target_state).toBe('PR Review');
    expect(entry.reason).toBe('pr-opened');
    expect(typeof entry.first_attempted_at).toBe('string');
    expect(typeof entry.last_attempted_at).toBe('string');
    expect(typeof entry.attempt_count).toBe('number');
    expect(entry.attempt_count).toBeGreaterThanOrEqual(1);
    expect(typeof entry.last_error).toBe('string');
  });

  it('appends (not overwrites) when queue already has rows', async () => {
    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-100/transitions', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transitions: [{ id: '6', name: 'PR Review', to: { name: 'PR Review' } }] }));
    });

    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-100', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: 'In Development' } } }));
    });

    stub.setRoute('POST', '/rest/api/3/issue/SCRUM-100/transitions', (_req, res) => {
      res.writeHead(503);
      res.end('Service Unavailable');
    });

    const retryQueue = path.join(tmpDir, 'retry.json');
    // Pre-seed with one existing row
    const existingRow = JSON.stringify({ ticket: 'SCRUM-EXISTING', target_state: 'Done', attempt_count: 1, reason: 'prior', project: 'SCRUM', first_attempted_at: new Date().toISOString(), last_attempted_at: new Date().toISOString(), last_error: 'prior error' });
    fs.writeFileSync(retryQueue, existingRow + '\n');

    await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--ticket', 'SCRUM-100',
      '--to', 'PR Review',
      '--reason', 'test-append'
    ], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: retryQueue,
      JIRA_BACKOFF_SEED_MS: '10',
      JIRA_BACKOFF_CAP_MS: '20'
    });

    const lines = fs.readFileSync(retryQueue, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).ticket).toBe('SCRUM-EXISTING');
    expect(JSON.parse(lines[1]).ticket).toBe('SCRUM-100');
  });
});
