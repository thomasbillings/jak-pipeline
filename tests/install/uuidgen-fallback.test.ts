/**
 * scripts/scrum-master/dispatch.sh uuidgen fallback path.
 *
 * The fallback chain — `uuidgen 2>/dev/null || python3 -c 'import uuid; ...'`
 * — exists for container images that ship without uuid-runtime. Verify both
 * legs: uuidgen present (uses it) and uuidgen missing (falls back to python3).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

// The exact one-liner used in scripts/scrum-master/dispatch.sh:124.
const UUID_EXPR = `SESSION_ID="$( { uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())'; } | tr 'A-Z' 'a-z')"; echo "$SESSION_ID"`;

const UUID_LOWER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('dispatch.sh uuidgen fallback chain', () => {
  it('produces a valid lowercase UUID when uuidgen is in PATH', () => {
    const r = spawnSync('bash', ['-c', UUID_EXPR], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(UUID_LOWER_RE);
  });

  it('falls back to python3 when uuidgen is not in PATH', () => {
    // Strip PATH down to /usr/bin and /bin (the local container has a
    // /usr/local/bin/uuidgen shim — exclude it so the fallback fires).
    const r = spawnSync('bash', ['-c', UUID_EXPR], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(UUID_LOWER_RE);
  });
});
