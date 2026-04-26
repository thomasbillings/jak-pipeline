import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CREDENTIAL_KEYS = ['MERGIFY_API_KEY', 'MERGIFY_ORG', 'GITHUB_TOKEN', 'MERGIFY_MCP_ROLE'];

// Repo root = the parent of mcp/mergify/ (i.e. jak-pipeline/)
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

const GUARDED_PATHS = [
  resolve(REPO_ROOT, '.env'),
  resolve(REPO_ROOT, 'mcp', 'mergify', '.env'),
];

function containsCredentials(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return CREDENTIAL_KEYS.some((key) => new RegExp(`^${key}\\s*=`, 'm').test(content));
  } catch {
    return false;
  }
}

export function checkEnvLeakGuard(): void {
  for (const guardedPath of GUARDED_PATHS) {
    if (existsSync(guardedPath) && containsCredentials(guardedPath)) {
      console.error(
        `[env-leak-guard] REFUSING to start: credential env vars found in in-repo file: ${guardedPath}\n` +
          `Place credentials at <downstream-project>/.claude/mcp/mergify/.env instead.`,
      );
      process.exit(1);
    }
  }
}
