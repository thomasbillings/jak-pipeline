/**
 * a3-a6: local-docker lifecycle script tests.
 * Covers: start, stop, accept, reject — Docker and transition.sh mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  makeTempDir,
  makeMockBin,
  makeMockDocker,
  runScript,
  scriptPath,
} from './_helpers.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

const START = scriptPath('local-docker-start.sh');
const STOP = scriptPath('local-docker-stop.sh');
const ACCEPT = scriptPath('local-docker-accept.sh');
const REJECT = scriptPath('local-docker-reject.sh');

function makeOverlay(tmpDir: string): string {
  const p = path.join(tmpDir, 'docker-compose.local-uat.yml');
  fs.writeFileSync(
    p,
    'version: "3"\nservices:\n  app:\n    image: test\n  postgres:\n    image: postgres\n'
  );
  return p;
}

describe('local-docker-start.sh (a3)', () => {
  let tmpDir: string;
  let binDir: string;
  let overlay: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    overlay = makeOverlay(tmpDir);
    makeMockDocker(binDir, { containerHealthy: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('invokes docker compose up -d with the supplied overlay path', async () => {
    const result = await runScript(START, [overlay], {
      PATH: `${binDir}:${process.env.PATH}`,
      UAT_HEALTHCHECK_TIMEOUT: '10',
    });

    const calls = fs.existsSync(path.join(binDir, 'docker.calls'))
      ? fs.readFileSync(path.join(binDir, 'docker.calls'), 'utf8')
      : '';

    expect(result.exitCode).toBe(0);
    expect(calls).toMatch(/up/);
    expect(calls).toMatch(/-d/);
    expect(calls).toContain(overlay);
  });

  it('exits non-zero on healthcheck timeout and prints last app logs to stderr', async () => {
    makeMockDocker(binDir, { containerHealthy: false });

    const result = await runScript(START, [overlay], {
      PATH: `${binDir}:${process.env.PATH}`,
      UAT_HEALTHCHECK_TIMEOUT: '2',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/timeout|timed out/i);
  });
});

describe('local-docker-stop.sh (a4)', () => {
  let tmpDir: string;
  let binDir: string;
  let overlay: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    overlay = makeOverlay(tmpDir);
    makeMockDocker(binDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('invokes docker compose down --remove-orphans with the overlay path', async () => {
    const result = await runScript(STOP, [overlay], {
      PATH: `${binDir}:${process.env.PATH}`,
    });

    const calls = fs.readFileSync(path.join(binDir, 'docker.calls'), 'utf8');
    expect(result.exitCode).toBe(0);
    expect(calls).toMatch(/down/);
    expect(calls).toMatch(/--remove-orphans/);
    expect(calls).toContain(overlay);
  });

  it('does NOT pass --volumes by default', async () => {
    await runScript(STOP, [overlay], {
      PATH: `${binDir}:${process.env.PATH}`,
    });
    const calls = fs.readFileSync(path.join(binDir, 'docker.calls'), 'utf8');
    expect(calls).not.toMatch(/--volumes/);
  });

  it('passes --volumes when --volumes flag is given', async () => {
    await runScript(STOP, [overlay, '--volumes'], {
      PATH: `${binDir}:${process.env.PATH}`,
    });
    const calls = fs.readFileSync(path.join(binDir, 'docker.calls'), 'utf8');
    expect(calls).toMatch(/--volumes/);
  });

  it('exits non-zero with message when docker compose down fails', async () => {
    makeMockDocker(binDir, { downExitCode: 1 });
    const result = await runScript(STOP, [overlay], {
      PATH: `${binDir}:${process.env.PATH}`,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/fail|error/i);
  });
});

describe('local-docker-accept.sh (a5)', () => {
  let tmpDir: string;
  let binDir: string;
  let skillRoot: string;
  let overlay: string;
  let transitionLog: string;
  let stopLog: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    binDir = path.join(tmpDir, 'bin');
    // Mock skill root: accepts JAK_SKILL_ROOT so transition.sh resolves to mock
    skillRoot = tmpDir;
    fs.mkdirSync(binDir);
    fs.mkdirSync(path.join(skillRoot, 'scripts', 'jira'), { recursive: true });
    overlay = makeOverlay(tmpDir);
    transitionLog = path.join(tmpDir, 'transition.calls');
    stopLog = path.join(tmpDir, 'stop.calls');
    // Place mock transition.sh where the script expects it: <skillRoot>/scripts/jira/transition.sh
    makeMockBin(path.join(skillRoot, 'scripts', 'jira'), 'transition.sh', 0, { logFile: transitionLog });
    // Place mock stop.sh in binDir (used via JAK_UAT_SCRIPTS_DIR)
    makeMockBin(binDir, 'local-docker-stop.sh', 0, { logFile: stopLog });
    makeMockDocker(binDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calls transition.sh with --project, ticket key, and target state "Done"', async () => {
    const result = await runScript(ACCEPT, ['SCRUM-42', overlay], {
      JAK_SKILL_ROOT: skillRoot,
      JAK_UAT_SCRIPTS_DIR: binDir,
      PATH: `${binDir}:${process.env.PATH}`,
    });
    expect(result.exitCode).toBe(0);
    const calls = fs.readFileSync(transitionLog, 'utf8');
    expect(calls).toContain('--project');
    expect(calls).toContain('SCRUM');
    expect(calls).toContain('SCRUM-42');
    expect(calls).toMatch(/[Dd]one/);
  });

  it('tears the stack down on Jira success', async () => {
    await runScript(ACCEPT, ['SCRUM-42', overlay], {
      JAK_SKILL_ROOT: skillRoot,
      JAK_UAT_SCRIPTS_DIR: binDir,
      PATH: `${binDir}:${process.env.PATH}`,
    });
    const stops = fs.existsSync(stopLog) ? fs.readFileSync(stopLog, 'utf8') : '';
    expect(stops).toContain(overlay);
  });

  it('tears the stack down even when Jira transition fails', async () => {
    // Make transition.sh fail
    makeMockBin(path.join(skillRoot, 'scripts', 'jira'), 'transition.sh', 1, { logFile: transitionLog });
    const retryFile = path.join(tmpDir, '_jira-retry.json');

    await runScript(ACCEPT, ['SCRUM-42', overlay], {
      JAK_SKILL_ROOT: skillRoot,
      JAK_UAT_SCRIPTS_DIR: binDir,
      PATH: `${binDir}:${process.env.PATH}`,
      JAK_JIRA_RETRY_FILE: retryFile,
    });
    const stops = fs.existsSync(stopLog) ? fs.readFileSync(stopLog, 'utf8') : '';
    expect(stops).toContain(overlay);
  });

  it('appends to _jira-retry.json when Jira transition fails', async () => {
    makeMockBin(path.join(skillRoot, 'scripts', 'jira'), 'transition.sh', 1, { logFile: transitionLog });
    const retryFile = path.join(tmpDir, '_jira-retry.json');

    await runScript(ACCEPT, ['SCRUM-42', overlay], {
      JAK_SKILL_ROOT: skillRoot,
      JAK_UAT_SCRIPTS_DIR: binDir,
      PATH: `${binDir}:${process.env.PATH}`,
      JAK_JIRA_RETRY_FILE: retryFile,
    });

    // Retry file must exist and contain the ticket key
    expect(fs.existsSync(retryFile)).toBe(true);
    const content = fs.readFileSync(retryFile, 'utf8');
    expect(content).toContain('SCRUM-42');
  });
});

describe('local-docker-reject.sh (a6)', () => {
  let tmpDir: string;
  let binDir: string;
  let skillRoot: string;
  let overlay: string;
  let transitionLog: string;
  let stopLog: string;
  let ghLog: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    binDir = path.join(tmpDir, 'bin');
    skillRoot = tmpDir;
    fs.mkdirSync(binDir);
    fs.mkdirSync(path.join(skillRoot, 'scripts', 'jira'), { recursive: true });
    overlay = makeOverlay(tmpDir);
    transitionLog = path.join(tmpDir, 'transition.calls');
    stopLog = path.join(tmpDir, 'stop.calls');
    ghLog = path.join(tmpDir, 'gh.calls');
    makeMockBin(path.join(skillRoot, 'scripts', 'jira'), 'transition.sh', 0, { logFile: transitionLog });
    makeMockBin(binDir, 'local-docker-stop.sh', 0, { logFile: stopLog });
    makeMockBin(binDir, 'gh', 0, { logFile: ghLog });
    makeMockDocker(binDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calls transition.sh with --project, ticket key, and target state "PR Review"', async () => {
    const result = await runScript(REJECT, ['SCRUM-7', overlay, 'does not meet AC'], {
      JAK_SKILL_ROOT: skillRoot,
      JAK_UAT_SCRIPTS_DIR: binDir,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_PR_NUMBER: '99',
    });
    expect(result.exitCode).toBe(0);
    const calls = fs.readFileSync(transitionLog, 'utf8');
    expect(calls).toContain('--project');
    expect(calls).toContain('SCRUM');
    expect(calls).toContain('SCRUM-7');
    expect(calls).toMatch(/PR Review/i);
  });

  it('posts a gh pr comment with the rejection reason', async () => {
    await runScript(REJECT, ['SCRUM-7', overlay, 'fails smoke test'], {
      JAK_SKILL_ROOT: skillRoot,
      JAK_UAT_SCRIPTS_DIR: binDir,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_PR_NUMBER: '99',
    });
    const calls = fs.readFileSync(ghLog, 'utf8');
    expect(calls).toMatch(/pr\s+comment/i);
    expect(calls).toMatch(/fails smoke test/);
  });

  it('tears the stack down after rejection', async () => {
    await runScript(REJECT, ['SCRUM-7', overlay, 'bad'], {
      JAK_SKILL_ROOT: skillRoot,
      JAK_UAT_SCRIPTS_DIR: binDir,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_PR_NUMBER: '99',
    });
    const stops = fs.existsSync(stopLog) ? fs.readFileSync(stopLog, 'utf8') : '';
    expect(stops).toContain(overlay);
  });
});
