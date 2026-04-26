/**
 * a2: run.sh strategy dispatcher tests.
 * Covers: none / local-docker / vercel-preview / fly-staging / unknown strategy.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTempDir, makeMockBin, runScript, scriptPath } from './_helpers.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DISPATCHER = scriptPath('run.sh');

describe('run.sh — strategy dispatcher (a2)', () => {
  let tmpDir: string;
  let binDir: string;
  let overlayPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    overlayPath = path.join(tmpDir, 'docker-compose.local-uat.yml');
    // Create a stub overlay file
    fs.writeFileSync(overlayPath, 'version: "3"\nservices:\n  app:\n    image: test\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 immediately when strategy is "none"', async () => {
    const result = await runScript(DISPATCHER, [], {
      JAK_UAT_STRATEGY: 'none',
      JAK_UAT_OVERLAY: overlayPath,
      PATH: `${binDir}:${process.env.PATH}`,
    });
    expect(result.exitCode).toBe(0);
  });

  it('invokes local-docker-start.sh with overlay path when strategy is "local-docker"', async () => {
    const logFile = path.join(tmpDir, 'start.calls');
    // Create a mock local-docker-start.sh in binDir
    makeMockBin(binDir, 'local-docker-start.sh', 0, { logFile });

    const result = await runScript(DISPATCHER, [], {
      JAK_UAT_STRATEGY: 'local-docker',
      JAK_UAT_OVERLAY: overlayPath,
      PATH: `${binDir}:${process.env.PATH}`,
    });

    expect(result.exitCode).toBe(0);
    const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    expect(calls).toContain(overlayPath);
  });

  it('exits 0 with stub message when strategy is "vercel-preview"', async () => {
    const result = await runScript(DISPATCHER, [], {
      JAK_UAT_STRATEGY: 'vercel-preview',
      JAK_UAT_OVERLAY: overlayPath,
      PATH: `${binDir}:${process.env.PATH}`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/stub/);
  });

  it('exits 0 with stub message when strategy is "fly-staging"', async () => {
    const result = await runScript(DISPATCHER, [], {
      JAK_UAT_STRATEGY: 'fly-staging',
      JAK_UAT_OVERLAY: overlayPath,
      PATH: `${binDir}:${process.env.PATH}`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/stub/);
  });

  it('exits non-zero and names the unknown strategy when an unrecognised value is given', async () => {
    const result = await runScript(DISPATCHER, [], {
      JAK_UAT_STRATEGY: 'banana-cloud',
      JAK_UAT_OVERLAY: overlayPath,
      PATH: `${binDir}:${process.env.PATH}`,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/banana-cloud/);
  });
});
