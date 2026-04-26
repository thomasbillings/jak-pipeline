/**
 * a2: read-before-write — skips POST if ticket already at target state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPT = scriptPath('transition.sh');

describe('transition.sh — read-before-write (a2)', () => {
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

  it('issues one GET and zero POST when ticket is already at target state', async () => {
    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-42', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: 'In Development' } } }));
    });

    const result = await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--ticket', 'SCRUM-42',
      '--to', 'In Development',
      '--reason', 'agent dispatched'
    ], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: path.join(tmpDir, 'retry.json')
    });

    expect(result.exitCode).toBe(0);

    const gets = stub.requests.filter((r) => r.method === 'GET' && r.url.includes('SCRUM-42'));
    const posts = stub.requests.filter((r) => r.method === 'POST');

    expect(gets.length).toBeGreaterThanOrEqual(1);
    expect(posts.length).toBe(0);
    expect(result.stdout).toMatch(/already at target/i);
  });
});
