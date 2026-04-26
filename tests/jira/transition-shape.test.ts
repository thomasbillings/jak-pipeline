/**
 * a1: transition.sh shape tests — exit 0 when stub server is down.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPT = scriptPath('transition.sh');

describe('transition.sh — shape (a1)', () => {
  let tmpDir: string;
  let envFile: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    // Point to a non-existent port so the server is "down"
    envFile = makeJiraEnvFile(tmpDir, { JIRA_BASE_URL: 'http://127.0.0.1:1' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 when Jira server is unreachable (never blocks GitHub pipeline)', async () => {
    const result = await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--ticket', 'SCRUM-1',
      '--to', 'In Development',
      '--reason', 'PR opened'
    ], {
      JIRA_BASE_URL: 'http://127.0.0.1:1',
      JIRA_ENV_FILE: envFile,
      JIRA_RETRY_QUEUE: path.join(tmpDir, 'retry.json')
    });

    expect(result.exitCode).toBe(0);
  });

  it('starts with #!/usr/bin/env bash and set -euo pipefail', async () => {
    const { createReadStream } = await import('node:fs');
    const lines: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(SCRIPT, { encoding: 'utf8' });
      let buf = '';
      stream.on('data', (d: string) => (buf += d));
      stream.on('end', () => { lines.push(...buf.split('\n')); resolve(); });
      stream.on('error', reject);
    });
    expect(lines[0]).toBe('#!/usr/bin/env bash');
    expect(lines.some((l) => l.includes('set -euo pipefail'))).toBe(true);
  });

  it('sources credentials from JIRA_ENV_FILE when set', async () => {
    const stub = await createStubJira();

    // GET /myself returns current user (basic auth check)
    stub.setRoute('GET', '/rest/api/3/issue/SCRUM-1', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fields: { status: { name: 'In Development' } } }));
    });

    const result = await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--ticket', 'SCRUM-1',
      '--to', 'In Development',
      '--reason', 'test'
    ], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: makeJiraEnvFile(tmpDir, { JIRA_BASE_URL: `http://127.0.0.1:${stub.port}` }),
      JIRA_RETRY_QUEUE: path.join(tmpDir, 'retry.json')
    });

    await stub.close();
    // Should be 0 — already at target → skip
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/already at target/i);
  });
});
