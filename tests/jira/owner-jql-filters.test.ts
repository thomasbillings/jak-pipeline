/**
 * a11: owner-jql-filters.md — parses markdown and asserts exact JQL substrings.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FILTERS_DOC = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../references/owner-jql-filters.md'
);

describe('owner-jql-filters.md (a11)', () => {
  it('file exists at references/owner-jql-filters.md', () => {
    expect(fs.existsSync(FILTERS_DOC)).toBe(true);
  });

  it('contains stale-work JQL with correct structure', () => {
    const content = fs.readFileSync(FILTERS_DOC, 'utf8');
    expect(content).toMatch(/stale[\s-]?work/i);
    // Must reference non-terminal status exclusion
    expect(content).toMatch(/status not in/i);
    // Must reference Done and Cancelled
    expect(content).toMatch(/Done/);
    expect(content).toMatch(/Cancelled/);
    // Must reference 7 days
    expect(content).toMatch(/-7d/);
  });

  it('contains agent-claimed-work JQL with correct structure', () => {
    const content = fs.readFileSync(FILTERS_DOC, 'utf8');
    expect(content).toMatch(/agent[\s-]?claimed[\s-]?work/i);
    // Must reference In Development
    expect(content).toMatch(/In Development/);
    // Must reference PR Review
    expect(content).toMatch(/PR Review/);
    // Must reference Merge Queue
    expect(content).toMatch(/Merge Queue/);
  });

  it('each filter has a "When to consult" line', () => {
    const content = fs.readFileSync(FILTERS_DOC, 'utf8');
    const occurrences = (content.match(/when to consult/gi) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('each filter has a "Configure for your project" snippet', () => {
    const content = fs.readFileSync(FILTERS_DOC, 'utf8');
    const occurrences = (content.match(/configure for your project/gi) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('stale-work JQL uses ORDER BY updated ASC', () => {
    const content = fs.readFileSync(FILTERS_DOC, 'utf8');
    expect(content).toMatch(/ORDER BY updated ASC/i);
  });

  it('agent-claimed-work JQL uses ORDER BY updated DESC', () => {
    const content = fs.readFileSync(FILTERS_DOC, 'utf8');
    expect(content).toMatch(/ORDER BY updated DESC/i);
  });
});
