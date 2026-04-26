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
  priority?: number;
  merge_method?: string;
  update_method?: string;
  batch_size?: number;
  speculative_checks?: number;
  allow_inplace_checks?: boolean;
  disabled?: boolean;
  conditions?: string[];
  queue_conditions?: string[];
}

interface MergifyConfig {
  queue_rules?: QueueRule[];
  pull_request_rules?: unknown[];
  defaults?: {
    actions?: {
      queue?: {
        merge_method?: string;
        update_method?: string;
        batch_size?: number;
        speculative_checks?: number;
        allow_inplace_checks?: boolean;
      };
    };
  };
}

describe('templates/.mergify.yml.tmpl', () => {
  let config: MergifyConfig;

  it('file exists and parses as valid YAML', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    config = yaml.load(raw) as MergifyConfig;
    expect(config).toBeTruthy();
  });

  it('has queue_rules array', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    config = yaml.load(raw) as MergifyConfig;
    expect(Array.isArray(config.queue_rules)).toBe(true);
    expect(config.queue_rules!.length).toBe(5);
  });

  it('defines all 5 named queues: bug, plan, feature, infra, design', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    config = yaml.load(raw) as MergifyConfig;
    const names = config.queue_rules!.map((q) => q.name);
    expect(names).toContain('bug');
    expect(names).toContain('plan');
    expect(names).toContain('feature');
    expect(names).toContain('infra');
    expect(names).toContain('design');
  });

  it('all queues start disabled: true (Day 0 state)', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    config = yaml.load(raw) as MergifyConfig;
    for (const queue of config.queue_rules!) {
      expect(queue.disabled, `queue ${queue.name} should be disabled`).toBe(true);
    }
  });

  it('bug queue: priority 4, branch glob fix/*, label queue:bug', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    config = yaml.load(raw) as MergifyConfig;
    const bug = config.queue_rules!.find((q) => q.name === 'bug')!;
    expect(bug.priority).toBe(4);
    const allConditions = [...(bug.conditions ?? []), ...(bug.queue_conditions ?? [])];
    expect(allConditions.some((c) => c.includes('fix/'))).toBe(true);
    expect(allConditions.some((c) => c.includes('queue:bug'))).toBe(true);
  });

  it('plan queue: priority 3, branch glob plan/*, label queue:plan', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    config = yaml.load(raw) as MergifyConfig;
    const plan = config.queue_rules!.find((q) => q.name === 'plan')!;
    expect(plan.priority).toBe(3);
    const allConditions = [...(plan.conditions ?? []), ...(plan.queue_conditions ?? [])];
    expect(allConditions.some((c) => c.includes('plan/'))).toBe(true);
    expect(allConditions.some((c) => c.includes('queue:plan'))).toBe(true);
  });

  it('feature queue: priority 2, branch glob feat/*, label queue:feature', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    config = yaml.load(raw) as MergifyConfig;
    const feature = config.queue_rules!.find((q) => q.name === 'feature')!;
    expect(feature.priority).toBe(2);
    const allConditions = [...(feature.conditions ?? []), ...(feature.queue_conditions ?? [])];
    expect(allConditions.some((c) => c.includes('feat/'))).toBe(true);
    expect(allConditions.some((c) => c.includes('queue:feature'))).toBe(true);
  });

  it('infra queue: priority 1, branch glob chore/*, label queue:infra', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    config = yaml.load(raw) as MergifyConfig;
    const infra = config.queue_rules!.find((q) => q.name === 'infra')!;
    expect(infra.priority).toBe(1);
    const allConditions = [...(infra.conditions ?? []), ...(infra.queue_conditions ?? [])];
    expect(allConditions.some((c) => c.includes('chore/'))).toBe(true);
    expect(allConditions.some((c) => c.includes('queue:infra'))).toBe(true);
  });

  it('design queue: priority 0, branch glob design/*, label queue:design', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    config = yaml.load(raw) as MergifyConfig;
    const design = config.queue_rules!.find((q) => q.name === 'design')!;
    expect(design.priority).toBe(0);
    const allConditions = [...(design.conditions ?? []), ...(design.queue_conditions ?? [])];
    expect(allConditions.some((c) => c.includes('design/'))).toBe(true);
    expect(allConditions.some((c) => c.includes('queue:design'))).toBe(true);
  });

  it('global section sets merge_method: squash', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    // merge_method can be in defaults or per-queue; check it appears somewhere
    expect(raw).toContain('squash');
  });

  it('global section sets update_method: rebase', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    expect(raw).toContain('rebase');
  });

  it('global section sets batch_size: 1', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    expect(raw).toContain('batch_size');
    expect(raw).toMatch(/batch_size:\s*1/);
  });

  it('global section sets speculative_checks: 1', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    expect(raw).toContain('speculative_checks');
    expect(raw).toMatch(/speculative_checks:\s*1/);
  });

  it('global section sets allow_inplace_checks: true', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    expect(raw).toMatch(/allow_inplace_checks:\s*true/);
  });

  it('check-success-or-neutral appears for required CI checks', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    // The template should reference check-success or equivalent
    expect(raw).toMatch(/check-success|success-or-neutral|check.*neutral/i);
  });
});
