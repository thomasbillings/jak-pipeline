import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TEMPLATE_PATH = resolve(REPO_ROOT, 'templates/.mergify.yml.tmpl');

interface QueueRule {
  name: string;
  merge_method?: string;
  update_method?: string;
  batch_size?: number;
  queue_conditions?: string[];
  merge_conditions?: string[];
}

interface MergifyConfig {
  queue_rules?: QueueRule[];
  pull_request_rules?: unknown[];
}

const QUEUE_NAMES = ['bug', 'plan', 'feature', 'infra', 'design'] as const;

/**
 * Extract the commented-out queue blocks from the template.
 *
 * The day-0 template ships with `queue_rules: []` (empty) and a series of
 * commented blocks below, each looking like:
 *
 *   # Queue: <name> — <description>
 *   # - name: <name>
 *   #   merge_method: squash
 *   #   ...
 *
 * Phase rollout uncomments a block. This helper strips the `# ` prefix from
 * those lines, glues the blocks together as if they were uncommented, and
 * parses the result as a YAML list. The returned array is the set of queue
 * shapes the template will produce as each phase ships.
 */
function extractCommentedQueueBlocks(raw: string): QueueRule[] {
  const lines = raw.split('\n');
  const reconstructed: string[] = [];
  let insideBlock = false;
  for (const line of lines) {
    // A block starts on `# - name: <queue>` and continues while subsequent
    // lines are commented + indented (start with `#   `) or are blank-comment
    // (`#`) lines.
    if (/^# - name:\s+\S/.test(line)) {
      insideBlock = true;
      reconstructed.push(line.replace(/^# /, ''));
      continue;
    }
    if (insideBlock) {
      if (/^#(\s|$)/.test(line)) {
        // Continuation: strip a single leading `# ` (or just `#` on blank lines).
        reconstructed.push(line.replace(/^# ?/, ''));
      } else {
        insideBlock = false;
      }
    }
  }
  if (reconstructed.length === 0) return [];
  const parsed = yaml.load(reconstructed.join('\n')) as QueueRule[] | null;
  return Array.isArray(parsed) ? parsed : [];
}

describe('templates/.mergify.yml.tmpl', () => {
  const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
  const config = yaml.load(raw) as MergifyConfig;
  const commentedQueues = extractCommentedQueueBlocks(raw);
  const byName = new Map(commentedQueues.map((q) => [q.name, q]));

  it('file exists and parses as valid YAML', () => {
    expect(config).toBeTruthy();
  });

  it('day-0 `queue_rules` is an empty array (no queue active until phase rollout)', () => {
    expect(Array.isArray(config.queue_rules)).toBe(true);
    expect(config.queue_rules!.length).toBe(0);
  });

  it('day-0 has `pull_request_rules: []`', () => {
    expect(Array.isArray(config.pull_request_rules)).toBe(true);
    expect(config.pull_request_rules!.length).toBe(0);
  });

  it('contains all 5 named queues as commented-out blocks', () => {
    const names = commentedQueues.map((q) => q.name).sort();
    expect(names).toEqual([...QUEUE_NAMES].sort());
  });

  it.each(QUEUE_NAMES)('commented block for %s queue has the expected shape', (name) => {
    const queue = byName.get(name);
    expect(queue, `commented block for ${name} not found`).toBeTruthy();
    expect(queue!.merge_method).toBe('squash');
    expect(queue!.update_method).toBe('rebase');
    expect(queue!.batch_size).toBe(1);
    expect(Array.isArray(queue!.queue_conditions)).toBe(true);
    expect(Array.isArray(queue!.merge_conditions)).toBe(true);
  });

  it.each([
    ['bug', '^fix/', 'queue:bug'],
    ['plan', '^plan/', 'queue:plan'],
    ['feature', '^feat/', 'queue:feature'],
    ['infra', '^chore/', 'queue:infra'],
    ['design', '^design/', 'queue:design'],
  ] as const)('%s queue gates on %s + label %s', (name, branchGlob, label) => {
    const queue = byName.get(name)!;
    const conds = queue.queue_conditions ?? [];
    expect(conds.some((c) => c.includes(branchGlob))).toBe(true);
    expect(conds.some((c) => c.includes(label))).toBe(true);
  });

  it('template does NOT use Mergify v1-invalid fields', () => {
    // These fields are not valid in current Mergify schema. Either they were
    // never valid (`disabled`), have moved to a separate section (`priority`
    // → `priority_rules`), or are deprecated (`speculative_checks`,
    // `allow_inplace_checks`). Asserting on the raw text catches both the
    // active queue_rules entries and the commented-out blocks.
    expect(raw).not.toMatch(/^\s*disabled:\s*true/m);
    expect(raw).not.toMatch(/^\s*priority:\s*\d/m);
    expect(raw).not.toMatch(/^\s*speculative_checks:/m);
    expect(raw).not.toMatch(/^\s*allow_inplace_checks:/m);
    // Commented-out occurrences in the explanatory header are fine — those
    // lines start with `#`. We only forbid them as live YAML keys.
  });

  it('check-success-or-neutral appears as the gate idiom', () => {
    expect(raw).toMatch(/check-success-or-neutral/);
  });

  it('template documents the comment-out phase-rollout mechanism', () => {
    // The header explains how to enable a queue; failing this assertion
    // means the explanatory comments were dropped, which would orphan
    // operators trying to roll out a queue.
    expect(raw).toMatch(/phase[- ]rollout/i);
    expect(raw).toMatch(/uncomment/i);
  });
});
