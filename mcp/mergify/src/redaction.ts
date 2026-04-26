export interface ErrorEnvelope {
  error: string;
  code?: string;
  details?: unknown;
}

// Token prefixes per a8 — exact match required by the test spec
const TOKEN_PATTERNS: RegExp[] = [
  /mrg_live_\S+/g,
  /mrg_test_\S+/g,
  /ghp_\S+/g,
  /ghs_\S+/g,
  /ghr_\S+/g,
  /github_pat_\S+/g,
];

function redactString(s: string): string {
  let result = s;
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
    // reset lastIndex since flags include /g
    pattern.lastIndex = 0;
  }
  return result;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

export function redactErrorEnvelope(env: ErrorEnvelope): ErrorEnvelope {
  return {
    ...env,
    error: redactString(env.error),
    ...(env.details !== undefined ? { details: redactValue(env.details) } : {}),
  };
}
