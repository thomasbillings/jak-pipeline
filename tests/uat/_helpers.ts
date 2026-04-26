/**
 * Shared test helpers for UAT script tests.
 * Mock executables are written to a temp bin dir and prepended to PATH.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Resolve a script in scripts/uat/ relative to the jak-pipeline repo root. */
export function scriptPath(name: string): string {
  const repoRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../..'
  );
  return path.join(repoRoot, 'scripts', 'uat', name);
}

/** Resolve a template file relative to the jak-pipeline repo root. */
export function templatePath(relPath: string): string {
  const repoRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../..'
  );
  return path.join(repoRoot, relPath);
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jak-uat-test-'));
}

/**
 * Write a fake executable that logs its argv to <logFile>, then exits with <exitCode>.
 * stdout/stderr are written if provided.
 */
export function makeMockBin(
  binDir: string,
  name: string,
  exitCode: number,
  {
    stdout = '',
    stderr = '',
    logFile = path.join(binDir, `${name}.calls`),
  }: { stdout?: string; stderr?: string; logFile?: string } = {}
): string {
  const binPath = path.join(binDir, name);
  const script = [
    '#!/usr/bin/env bash',
    `echo "$0 $*" >> "${logFile}"`,
    stdout ? `echo ${JSON.stringify(stdout)}` : '',
    stderr ? `echo ${JSON.stringify(stderr)} >&2` : '',
    `exit ${exitCode}`,
  ]
    .filter(Boolean)
    .join('\n');
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

/**
 * Make a mock docker binary that logs calls and responds appropriately.
 * containerHealthy: if true, ps returns healthy status on first call.
 */
export function makeMockDocker(
  binDir: string,
  opts: {
    upExitCode?: number;
    downExitCode?: number;
    containerHealthy?: boolean;
    logFile?: string;
  } = {}
): void {
  const {
    upExitCode = 0,
    downExitCode = 0,
    containerHealthy = true,
    logFile = path.join(binDir, 'docker.calls'),
  } = opts;

  const healthJson = containerHealthy
    ? JSON.stringify([{ Health: 'healthy' }])
    : JSON.stringify([{ Health: 'starting' }]);

  const script = [
    '#!/usr/bin/env bash',
    `echo "docker $*" >> "${logFile}"`,
    'shift  # consume "compose"',
    'CMD=""',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    up) CMD=up ;;',
    '    down) CMD=down ;;',
    '    ps) CMD=ps ;;',
    '    logs) CMD=logs ;;',
    '  esac',
    '  shift',
    'done',
    `case "$CMD" in`,
    `  up) exit ${upExitCode} ;;`,
    `  down) exit ${downExitCode} ;;`,
    `  ps) echo '${healthJson}' ; exit 0 ;;`,
    `  logs) echo "app log line 1"; exit 0 ;;`,
    `  *) exit 0 ;;`,
    `esac`,
  ].join('\n');

  fs.writeFileSync(path.join(binDir, 'docker'), script, { mode: 0o755 });
}

/** Run a script with a custom PATH that prepends binDir for mock binaries. */
export function runScript(
  scriptFile: string,
  args: string[],
  env: Record<string, string | undefined>
): Promise<RunResult> {
  return new Promise((resolve) => {
    const spawnEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...env })) {
      if (v !== undefined) spawnEnv[k] = v;
    }

    const child = spawn('bash', [scriptFile, ...args], {
      env: spawnEnv as NodeJS.ProcessEnv,
    } as SpawnOptions);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}
