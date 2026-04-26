/**
 * a7 / a11: storybook-preview.yml workflow template tests.
 * Parses templates/github-actions/storybook-preview.yml and asserts shape.
 */

import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import * as fs from 'node:fs';
import { templatePath } from './_helpers.ts';

const WORKFLOW_PATH = templatePath('templates/github-actions/storybook-preview.yml');

function loadWorkflow(): Record<string, unknown> {
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  return parse(raw) as Record<string, unknown>;
}

describe('storybook-preview.yml workflow template (a7, a11)', () => {
  it('the template file exists at templates/github-actions/storybook-preview.yml', () => {
    expect(fs.existsSync(WORKFLOW_PATH)).toBe(true);
  });

  it('only runs when pull_request.draft is false (draft-skip rule)', () => {
    const wf = loadWorkflow();
    // The workflow must have an `if:` condition or a jobs.<job>.if that checks draft == false
    const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    expect(raw).toMatch(/github\.event\.pull_request\.draft\s*==\s*false/);
  });

  it('is triggered by pull_request event targeting main', () => {
    const wf = loadWorkflow();
    const on = wf['on'] as Record<string, unknown>;
    expect(on).toBeDefined();
    const pr = on['pull_request'] as Record<string, unknown> | undefined;
    expect(pr).toBeDefined();
    const branches = (pr?.['branches'] ?? pr?.['branches-ignore']) as string[] | undefined;
    // Should include main in the branches list
    if (branches) {
      expect(branches).toContain('main');
    } else {
      // No branch filter means all branches including main — acceptable
      expect(pr).toBeDefined();
    }
  });

  it('consumes CF_PAGES_PROJECT from env', () => {
    const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    expect(raw).toMatch(/CF_PAGES_PROJECT/);
    // Must be an env var reference, not a hardcoded value
    expect(raw).toMatch(/\$\{\{?\s*env\.CF_PAGES_PROJECT/);
  });

  it('consumes CF_API_TOKEN from secrets.CF_API_TOKEN', () => {
    const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    expect(raw).toMatch(/secrets\.CF_API_TOKEN/);
  });

  it('passes --only-changed to the Storybook build step', () => {
    const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    expect(raw).toMatch(/--only-changed/);
  });

  it('does not hardcode TnT-Finance-specific paths or branch names', () => {
    const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    // Should not contain tnt-finance or TnT-Finance references
    expect(raw).not.toMatch(/tnt-?finance/i);
    // Should not hardcode a specific image name
    expect(raw).not.toMatch(/thomasbillings\/tnt-finance/i);
  });

  it('is parameterised by package_manager env var at the top', () => {
    const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    expect(raw).toMatch(/package_manager/i);
  });
});
