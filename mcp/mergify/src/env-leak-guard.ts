import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Env vars whose presence in an in-repo .env indicates a credential leak (or role misconfiguration).
// MERGIFY_MCP_ROLE is role config, not a credential, but placing it in the repo .env is equally wrong —
// it would be injected at agent dispatch, not stored in a file inside the repo.
const GUARDED_ENV_KEYS = ['MERGIFY_API_KEY', 'MERGIFY_ORG', 'GITHUB_TOKEN', 'MERGIFY_MCP_ROLE'];

// Repo root = jak-pipeline/ (4 levels up from this file: src/env-leak-guard.ts)
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

export const DEFAULT_GUARDED_PATHS = [
  resolve(REPO_ROOT, '.env'),
  resolve(REPO_ROOT, 'mcp', 'mergify', '.env'),
];

export function containsCredentials(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return GUARDED_ENV_KEYS.some((key) => new RegExp(`^${key}\\s*=`, 'm').test(content));
  } catch {
    return false;
  }
}

export function checkEnvLeakGuard(guardedPaths: string[] = DEFAULT_GUARDED_PATHS): void {
  for (const guardedPath of guardedPaths) {
    if (existsSync(guardedPath) && containsCredentials(guardedPath)) {
      console.error(
        `[env-leak-guard] REFUSING to start: credential env vars found in in-repo file: ${guardedPath}\n` +
          `Place credentials at <downstream-project>/.claude/mcp/mergify/.env instead.`,
      );
      process.exit(1);
    }
  }
}
