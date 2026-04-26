import { describe, it, expect } from 'vitest';

// These tests verify the redaction wrapper per acceptance criterion a8.
// The redactErrorEnvelope function does not exist yet — all tests FAIL red.

// Real-looking synthetic tokens for each required prefix (a8 explicit requirement)
const SYNTHETIC_TOKENS = {
  mrg_live: 'mrg_live_FAKEFAKEFAKEFAKE1234567890abcdef',
  mrg_test: 'mrg_test_FAKEFAKEFAKEFAKE1234567890abcdef',
  ghp: 'ghp_FAKEFAKEFAKEFAKE1234567890abcdef',
  ghs: 'ghs_FAKEFAKEFAKEFAKE1234567890abcdef',
  ghr: 'ghr_FAKEFAKEFAKEFAKE1234567890abcdef',
  github_pat: 'github_pat_FAKEFAKEFAKEFAKE_1234567890abcdef',
} as const;

interface ErrorEnvelope {
  error: string;
  code?: string;
  details?: unknown;
}

async function getRedactFn(): Promise<(env: ErrorEnvelope) => ErrorEnvelope> {
  const { redactErrorEnvelope } = await import('../src/redaction.js');
  return redactErrorEnvelope;
}

describe('redaction wrapper (a8)', () => {
  it('strips mrg_live_ prefixed tokens from error message', async () => {
    const redact = await getRedactFn();
    const env: ErrorEnvelope = { error: `API call failed: ${SYNTHETIC_TOKENS.mrg_live}` };
    const result = redact(env);
    expect(result.error).not.toContain(SYNTHETIC_TOKENS.mrg_live);
    expect(result.error).not.toContain('mrg_live_');
  });

  it('strips mrg_test_ prefixed tokens from error message', async () => {
    const redact = await getRedactFn();
    const env: ErrorEnvelope = { error: `Request error: ${SYNTHETIC_TOKENS.mrg_test}` };
    const result = redact(env);
    expect(result.error).not.toContain(SYNTHETIC_TOKENS.mrg_test);
    expect(result.error).not.toContain('mrg_test_');
  });

  it('strips ghp_ prefixed tokens from error message', async () => {
    const redact = await getRedactFn();
    const env: ErrorEnvelope = { error: `GitHub auth failed: ${SYNTHETIC_TOKENS.ghp}` };
    const result = redact(env);
    expect(result.error).not.toContain(SYNTHETIC_TOKENS.ghp);
    expect(result.error).not.toContain('ghp_');
  });

  it('strips ghs_ prefixed tokens from error message', async () => {
    const redact = await getRedactFn();
    const env: ErrorEnvelope = { error: `GitHub session token ${SYNTHETIC_TOKENS.ghs} in trace` };
    const result = redact(env);
    expect(result.error).not.toContain(SYNTHETIC_TOKENS.ghs);
    expect(result.error).not.toContain('ghs_');
  });

  it('strips ghr_ prefixed tokens from error message', async () => {
    const redact = await getRedactFn();
    const env: ErrorEnvelope = { error: `Refresh token: ${SYNTHETIC_TOKENS.ghr}` };
    const result = redact(env);
    expect(result.error).not.toContain(SYNTHETIC_TOKENS.ghr);
    expect(result.error).not.toContain('ghr_');
  });

  it('strips github_pat_ prefixed tokens from error message', async () => {
    const redact = await getRedactFn();
    const env: ErrorEnvelope = { error: `PAT leak: ${SYNTHETIC_TOKENS.github_pat}` };
    const result = redact(env);
    expect(result.error).not.toContain(SYNTHETIC_TOKENS.github_pat);
    expect(result.error).not.toContain('github_pat_');
  });

  it('strips tokens from nested details object', async () => {
    const redact = await getRedactFn();
    const env: ErrorEnvelope = {
      error: 'upstream error',
      details: {
        message: `raw response body contained ${SYNTHETIC_TOKENS.mrg_live}`,
        headers: { authorization: `Bearer ${SYNTHETIC_TOKENS.ghp}` },
      },
    };
    const result = redact(env);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(SYNTHETIC_TOKENS.mrg_live);
    expect(serialised).not.toContain(SYNTHETIC_TOKENS.ghp);
  });

  it('strips tokens embedded in a stack trace string in details', async () => {
    const redact = await getRedactFn();
    const stackWithToken = `Error: fetch failed\n  at Object.fetch\nCaused by: Authorization: ${SYNTHETIC_TOKENS.mrg_test}\n  at MergifyClient.get`;
    const env: ErrorEnvelope = { error: 'tool error', details: stackWithToken };
    const result = redact(env);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(SYNTHETIC_TOKENS.mrg_test);
  });

  it('preserves non-sensitive error content', async () => {
    const redact = await getRedactFn();
    const env: ErrorEnvelope = { error: 'Queue not found: my-queue-name', code: 'QUEUE_NOT_FOUND' };
    const result = redact(env);
    expect(result.error).toBe('Queue not found: my-queue-name');
    expect(result.code).toBe('QUEUE_NOT_FOUND');
  });

  it('handles all 6 token prefixes in a single error envelope', async () => {
    const redact = await getRedactFn();
    const allTokens = Object.values(SYNTHETIC_TOKENS).join(' ');
    const env: ErrorEnvelope = { error: `Multi-token leak: ${allTokens}` };
    const result = redact(env);
    for (const token of Object.values(SYNTHETIC_TOKENS)) {
      expect(result.error).not.toContain(token);
    }
  });
});
