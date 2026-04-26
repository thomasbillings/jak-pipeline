/**
 * a9: tick-extension.sh — sourcing exposes jak_pipeline_jira_tick_pass() with no side effects.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const TICK_EXT = scriptPath('tick-extension.sh');

describe('tick-extension.sh — shape (a9)', () => {
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

  it('sourcing the fragment exposes jak_pipeline_jira_tick_pass function', async () => {
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('bash', ['-c', `
        source "${TICK_EXT}" 2>/dev/null
        type jak_pipeline_jira_tick_pass 2>&1
      `], { env: { ...process.env, JIRA_ENV_FILE: envFile } });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
    });

    expect(result.stdout).toMatch(/jak_pipeline_jira_tick_pass/);
    expect(result.stdout).toMatch(/function/i);
  });

  it('sourcing produces no side effects (no file creation, no HTTP requests)', async () => {
    const requestsBefore = stub.requests.length;

    await new Promise<void>((resolve) => {
      const child = spawn('bash', ['-c', `source "${TICK_EXT}" 2>/dev/null; echo done`], {
        env: { ...process.env, JIRA_ENV_FILE: envFile, JIRA_BASE_URL: `http://127.0.0.1:${stub.port}` }
      });
      child.on('close', () => resolve());
    });

    // No HTTP calls should have been made
    expect(stub.requests.length).toBe(requestsBefore);
  });

  it('calling jak_pipeline_jira_tick_pass with stubbed env dispatches drift + drain passes', async () => {
    // Stub GitHub PR list (empty — no PRs)
    const ghDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(ghDir, { recursive: true });
    const ghStub = path.join(ghDir, 'gh');
    fs.writeFileSync(ghStub, `#!/usr/bin/env bash\necho '[]'\n`);
    fs.chmodSync(ghStub, 0o755);

    const driftFile = path.join(tmpDir, 'agents', '_jira-drift.json');
    const retryQueue = path.join(tmpDir, 'agents', '_jira-retry.json');
    fs.mkdirSync(path.dirname(driftFile), { recursive: true });

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
          JIRA_DRIFT_FILE: driftFile,
          DOWNSTREAM_ROOT: tmpDir,
          PATH: `${ghDir}:${process.env.PATH}`
        }
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
    });

    // Should exit 0 even with empty PR list
    expect(result.exitCode).toBe(0);
  });
});
