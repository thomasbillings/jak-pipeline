/**
 * Vitest globalSetup — runs once before any test starts.
 *
 * Builds mcp/mergify/dist if missing so the install-script tests
 * (tests/install/plan*.test.ts) don't race to build it in parallel
 * the first time the suite runs against a fresh checkout.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MCP_SRC = path.join(REPO_ROOT, 'mcp', 'mergify');
const DIST_MARKER = path.join(MCP_SRC, 'dist', 'server.js');

export default async function setup() {
  if (fs.existsSync(DIST_MARKER)) {
    return;
  }

  // Need to install deps first if node_modules is missing
  const hasNodeModules = fs.existsSync(path.join(MCP_SRC, 'node_modules'));
  if (!hasNodeModules) {
    const ci = spawnSync('npm', ['ci', '--silent'], { cwd: MCP_SRC, stdio: 'inherit' });
    if (ci.status !== 0) {
      throw new Error(`global-setup: 'npm ci' in mcp/mergify failed with status ${ci.status}`);
    }
  }

  const build = spawnSync('npm', ['run', 'build', '--silent'], { cwd: MCP_SRC, stdio: 'inherit' });
  if (build.status !== 0) {
    throw new Error(`global-setup: 'npm run build' in mcp/mergify failed with status ${build.status}`);
  }
}
