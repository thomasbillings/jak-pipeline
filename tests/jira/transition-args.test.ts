/**
 * a1: transition.sh argument validation tests.
 * Non-zero exit only on missing/malformed CLI flags.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPT = scriptPath('transition.sh');

describe('transition.sh — argument validation (a1)', () => {
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

  it('exits non-zero when --project is missing', async () => {
    const r = await runScript(SCRIPT, [
      '--ticket', 'SCRUM-1',
      '--to', 'In Development',
      '--reason', 'test'
    ], { JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`, JIRA_ENV_FILE: envFile });
    expect(r.exitCode).not.toBe(0);
  });

  it('exits non-zero when --ticket is missing', async () => {
    const r = await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--to', 'In Development',
      '--reason', 'test'
    ], { JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`, JIRA_ENV_FILE: envFile });
    expect(r.exitCode).not.toBe(0);
  });

  it('exits non-zero when --to is missing', async () => {
    const r = await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--ticket', 'SCRUM-1',
      '--reason', 'test'
    ], { JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`, JIRA_ENV_FILE: envFile });
    expect(r.exitCode).not.toBe(0);
  });

  it('exits non-zero when --reason is missing', async () => {
    const r = await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--ticket', 'SCRUM-1',
      '--to', 'In Development'
    ], { JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`, JIRA_ENV_FILE: envFile });
    expect(r.exitCode).not.toBe(0);
  });

  it('exits 0 when all four required flags are provided', async () => {
    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-1', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: 'In Development' } } }));
    });

    const r = await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--ticket', 'SCRUM-1',
      '--to', 'In Development',
      '--reason', 'test'
    ], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: path.join(tmpDir, 'retry.json')
    });
    expect(r.exitCode).toBe(0);
  });
});
