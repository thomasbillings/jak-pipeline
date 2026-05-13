/**
 * install.sh Plan 1 section — MCP server install into <downstream>/.claude/mcp/mergify/.
 *
 * Uses JAK_PLAN1_SKIP_NPM=1 to skip the `npm ci --omit=dev` step inside the
 * fixture (production installs do run npm ci; this just keeps tests fast).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const INSTALL_SCRIPT = path.join(SKILL_ROOT, 'scripts', 'install.sh');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jak-install-plan1-'));
}

function runInstall(tmpDir: string, extraEnv: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [INSTALL_SCRIPT], {
      env: {
        ...process.env,
        DOWNSTREAM_ROOT: tmpDir,
        JAK_SKILL_ROOT: SKILL_ROOT,
        PLAN1_ONLY: '1',
        JAK_PLAN1_SKIP_NPM: '1',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

describe('install.sh — Plan 1 section', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies dist/, src/, package.json to <downstream>/.claude/mcp/mergify/', async () => {
    const result = await runInstall(tmpDir);
    expect(result.exitCode).toBe(0);

    const mcpDest = path.join(tmpDir, '.claude', 'mcp', 'mergify');
    expect(fs.existsSync(path.join(mcpDest, 'dist', 'server.js'))).toBe(true);
    expect(fs.existsSync(path.join(mcpDest, 'src', 'server.ts'))).toBe(true);
    expect(fs.existsSync(path.join(mcpDest, 'package.json'))).toBe(true);
  });

  it('templates .env from .env.example when none exists', async () => {
    await runInstall(tmpDir);
    const envFile = path.join(tmpDir, '.claude', 'mcp', 'mergify', '.env');
    expect(fs.existsSync(envFile)).toBe(true);
    const content = fs.readFileSync(envFile, 'utf8');
    expect(content).toMatch(/MERGIFY_API_KEY/);
    expect(content).toMatch(/MERGIFY_ORG/);
    expect(content).toMatch(/GITHUB_TOKEN/);
    expect(content).toMatch(/MERGIFY_MCP_ROLE/);
  });

  it('does NOT overwrite an existing .env', async () => {
    const envFile = path.join(tmpDir, '.claude', 'mcp', 'mergify', '.env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, 'MERGIFY_API_KEY=mrg_live_REAL\nMERGIFY_ORG=acme\n');

    await runInstall(tmpDir);

    const content = fs.readFileSync(envFile, 'utf8');
    expect(content).toContain('mrg_live_REAL');
    expect(content).toContain('acme');
  });

  it('writes an executable run.sh wrapper that sources .env and execs node', async () => {
    await runInstall(tmpDir);
    const runSh = path.join(tmpDir, '.claude', 'mcp', 'mergify', 'run.sh');
    expect(fs.existsSync(runSh)).toBe(true);
    // executable
    const stat = fs.statSync(runSh);
    expect(stat.mode & 0o111).not.toBe(0);
    const content = fs.readFileSync(runSh, 'utf8');
    expect(content).toMatch(/\. \.\/\.env/);
    expect(content).toMatch(/exec node \.\/dist\/server\.js/);
  });

  it('registers the mergify server in .mcp.json', async () => {
    await runInstall(tmpDir);
    const mcpJson = path.join(tmpDir, '.mcp.json');
    expect(fs.existsSync(mcpJson)).toBe(true);
    const data = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
    expect(data.mcpServers).toBeDefined();
    expect(data.mcpServers.mergify).toBeDefined();
    expect(data.mcpServers.mergify.command).toBe('bash');
    expect(data.mcpServers.mergify.args).toContain('.claude/mcp/mergify/run.sh');
  });

  it('preserves pre-existing entries in .mcp.json when registering mergify', async () => {
    const mcpJson = path.join(tmpDir, '.mcp.json');
    fs.writeFileSync(mcpJson, JSON.stringify({
      mcpServers: {
        'other-server': { command: 'node', args: ['./other.js'] },
      },
    }, null, 2));

    await runInstall(tmpDir);

    const data = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
    expect(data.mcpServers['other-server']).toBeDefined();
    expect(data.mcpServers['other-server'].command).toBe('node');
    expect(data.mcpServers.mergify).toBeDefined();
  });

  it('installs the pre-commit hook (.git/hooks/pre-commit) idempotently', async () => {
    // Need a fake .git/ to write the hook into
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    await runInstall(tmpDir);
    const hook = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    expect(fs.existsSync(hook)).toBe(true);
    const content1 = fs.readFileSync(hook, 'utf8');
    expect(content1).toContain('jak-pipeline pre-commit token-prefix scan');

    // Second run — should not duplicate the sentinel
    await runInstall(tmpDir);
    const content2 = fs.readFileSync(hook, 'utf8');
    const matches = (content2.match(/jak-pipeline pre-commit token-prefix scan/g) || []).length;
    expect(matches).toBe(1);
  });

  it('copies scripts/hooks/pre-commit into <downstream>/scripts/hooks/ so the dispatcher resolves', async () => {
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    await runInstall(tmpDir);

    const hookSrc = path.join(tmpDir, 'scripts', 'hooks', 'pre-commit');
    expect(fs.existsSync(hookSrc)).toBe(true);
    const stat = fs.statSync(hookSrc);
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it('is idempotent — second run preserves user .env and re-registers mergify cleanly', async () => {
    await runInstall(tmpDir);

    // Mutate the .env as a user would
    const envFile = path.join(tmpDir, '.claude', 'mcp', 'mergify', '.env');
    fs.appendFileSync(envFile, '\n# user added comment\n');
    const beforeContent = fs.readFileSync(envFile, 'utf8');

    // Re-run
    const result = await runInstall(tmpDir);
    expect(result.exitCode).toBe(0);

    const afterContent = fs.readFileSync(envFile, 'utf8');
    expect(afterContent).toBe(beforeContent);

    // .mcp.json still well-formed
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'));
    expect(data.mcpServers.mergify).toBeDefined();
  });
});
