/**
 * a17: doctor.sh Plan 3 section — temp-dir, stub Jira /myself, exit-code matrix.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const DOCTOR_SCRIPT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../scripts/doctor.sh'
);

async function runDoctor(tmpDir: string, stub: StubServer | null, opts: {
  envFile?: string;
  tickShContent?: string;
  retryQueueContent?: string;
} = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const downstream = path.join(tmpDir, 'downstream');
  fs.mkdirSync(path.join(downstream, 'scripts', 'coordinator'), { recursive: true });
  fs.mkdirSync(path.join(downstream, '.claude', 'jira'), { recursive: true });
  fs.mkdirSync(path.join(downstream, 'agents'), { recursive: true });

  const tickSh = path.join(downstream, 'scripts', 'coordinator', 'tick.sh');
  const tickContent = opts.tickShContent ?? `#!/usr/bin/env bash\n. scripts/jak-pipeline/jira/tick-extension.sh\njak_pipeline_jira_tick_pass\n`;
  fs.writeFileSync(tickSh, tickContent);

  if (opts.retryQueueContent !== undefined) {
    const retryQueue = path.join(downstream, 'agents', '_jira-retry.json');
    fs.writeFileSync(retryQueue, opts.retryQueueContent);
  }

  const envFile = opts.envFile ?? (stub
    ? makeJiraEnvFile(path.join(tmpDir, 'env'), { JIRA_BASE_URL: `http://127.0.0.1:${stub.port}` })
    : makeJiraEnvFile(path.join(tmpDir, 'env'), {}));

  fs.mkdirSync(path.join(tmpDir, 'env'), { recursive: true });
  fs.copyFileSync(envFile, path.join(downstream, '.claude', 'jira', '.env'));

  return new Promise((resolve) => {
    const child = spawn('bash', [DOCTOR_SCRIPT], {
      env: {
        ...process.env,
        DOWNSTREAM_ROOT: downstream,
        PLAN3_CHECK: '1'  // signal to run only Plan 3 checks
      }
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

describe('doctor.sh — Plan 3 checks (a17)', () => {
  let tmpDir: string;
  let stub: StubServer;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    stub = await createStubJira();
    // /myself returns 200
    stub.setRoute('GET', '/rest/api/3/myself', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accountId: 'test-user', displayName: 'Test User' }));
    });
  });

  afterEach(async () => {
    await stub.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 with all checks present when setup is correct', async () => {
    const result = await runDoctor(tmpDir, stub);
    expect(result.exitCode).toBe(0);
    // Should mention Plan 3 checks passing
    expect(result.stdout + result.stderr).toMatch(/Plan 3/i);
  });

  it('exits non-zero when Jira /myself returns 401', async () => {
    stub.setRoute('GET', '/rest/api/3/myself', (_req, res) => {
      res.writeHead(401);
      res.end('Unauthorized');
    });

    const result = await runDoctor(tmpDir, stub);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/credential|auth|401/i);
  });

  it('exits non-zero when retry queue has rows older than 24h', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const staleRow = JSON.stringify({
      ticket: 'SCRUM-STUCK',
      target_state: 'Done',
      attempt_count: 3,
      first_attempted_at: staleDate,
      last_attempted_at: staleDate,
      last_error: 'HTTP 503',
      reason: 'test',
      project: 'SCRUM'
    });

    const result = await runDoctor(tmpDir, stub, { retryQueueContent: staleRow + '\n' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/stuck|stale|retry|24h/i);
  });

  it('exits non-zero when tick.sh lacks jak_pipeline_jira_tick_pass', async () => {
    const result = await runDoctor(tmpDir, stub, {
      tickShContent: '#!/usr/bin/env bash\necho "plain tick"\n'
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/tick\.sh|jak_pipeline_jira_tick_pass/i);
  });
});
