import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkEnvLeakGuard } from '../src/env-leak-guard.js';

function makeTempEnv(content: string): string {
  const path = resolve(tmpdir(), `jak-test-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, content);
  return path;
}

function captureExit(): { code: number | null; restore: () => void } {
  const state = { code: null as number | null };
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
    state.code = typeof code === 'number' ? code : 1;
    throw new Error(`process.exit(${state.code})`);
  });
  return { ...state, restore: () => vi.restoreAllMocks() };
}

describe('env-leak-guard (a12)', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const f of tempFiles.splice(0)) {
      if (existsSync(f)) unlinkSync(f);
    }
    vi.restoreAllMocks();
  });

  it('does not exit when guarded paths list is empty', () => {
    const cap = captureExit();
    expect(() => checkEnvLeakGuard([])).not.toThrow();
    expect(cap.code).toBeNull();
    cap.restore();
  });

  it('does not exit when guarded .env contains no credential keys', () => {
    const path = makeTempEnv('DATABASE_URL=postgres://localhost/db\nPORT=3000\n');
    tempFiles.push(path);
    const cap = captureExit();

    expect(() => checkEnvLeakGuard([path])).not.toThrow();
    expect(cap.code).toBeNull();
    cap.restore();
  });

  it('refuses and exits non-zero when .env contains MERGIFY_API_KEY', () => {
    const path = makeTempEnv('MERGIFY_API_KEY=mrg_live_FAKE\nMERGIFY_ORG=my-org\n');
    tempFiles.push(path);
    const cap = captureExit();

    expect(() => checkEnvLeakGuard([path])).toThrow('process.exit(1)');
    cap.restore();
  });

  it('refuses and exits non-zero when .env contains GITHUB_TOKEN', () => {
    const path = makeTempEnv('GITHUB_TOKEN=ghp_FAKETOKEN\n');
    tempFiles.push(path);
    const cap = captureExit();

    expect(() => checkEnvLeakGuard([path])).toThrow('process.exit(1)');
    cap.restore();
  });

  it('refuses and exits non-zero when .env contains MERGIFY_ORG', () => {
    const path = makeTempEnv('MERGIFY_ORG=my-org\n');
    tempFiles.push(path);
    const cap = captureExit();

    expect(() => checkEnvLeakGuard([path])).toThrow('process.exit(1)');
    cap.restore();
  });

  it('refuses and exits non-zero when .env contains MERGIFY_MCP_ROLE', () => {
    const path = makeTempEnv('MERGIFY_MCP_ROLE=coordinator\n');
    tempFiles.push(path);
    const cap = captureExit();

    expect(() => checkEnvLeakGuard([path])).toThrow('process.exit(1)');
    cap.restore();
  });

  it('checks the second path if the first is clean', () => {
    const clean = makeTempEnv('DATABASE_URL=postgres://localhost/db\n');
    const dirty = makeTempEnv('MERGIFY_API_KEY=mrg_live_FAKE\n');
    tempFiles.push(clean, dirty);
    const cap = captureExit();

    expect(() => checkEnvLeakGuard([clean, dirty])).toThrow('process.exit(1)');
    cap.restore();
  });

  it('accepts a nonexistent path without error', () => {
    const cap = captureExit();
    expect(() => checkEnvLeakGuard(['/tmp/definitely-does-not-exist-12345.env'])).not.toThrow();
    cap.restore();
  });

  it('DEFAULT_GUARDED_PATHS contains both repo root .env and mcp/mergify/.env', async () => {
    const { DEFAULT_GUARDED_PATHS } = await import('../src/env-leak-guard.js');
    expect(DEFAULT_GUARDED_PATHS).toHaveLength(2);
    // Match any 'jak-pipeline'-prefixed directory (covers worktrees like
    // `jak-pipeline-triage` whose root resolves to a different basename).
    expect(DEFAULT_GUARDED_PATHS[0]).toMatch(/jak-pipeline[^/\\]*[/\\]\.env$/);
    expect(DEFAULT_GUARDED_PATHS[1]).toMatch(/mcp[/\\]mergify[/\\]\.env$/);
  });
});
