import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const COOKBOOK_PATH = resolve(REPO_ROOT, 'templates/phase-rollout-commits.md');

const PHASES = ['Day 1-2', 'Day 3-5', 'Day 6-13', 'Day 14+'];

describe('templates/phase-rollout-commits.md', () => {
  const content = existsSync(COOKBOOK_PATH) ? readFileSync(COOKBOOK_PATH, 'utf-8') : '';

  it('file exists', () => {
    expect(existsSync(COOKBOOK_PATH)).toBe(true);
  });

  it('has one section per phase (Day 1-2, Day 3-5, Day 6-13, Day 14+)', () => {
    for (const phase of PHASES) {
      expect(content, `missing section for ${phase}`).toContain(phase);
    }
  });

  it.each([
    ['Day 1-2', 'queue:plan'],
    ['Day 3-5', 'queue:infra'],
  ])('%s section enables %s', (phase, queue) => {
    // Slice the section between `## <phase>` and the next `## ` heading.
    const re = new RegExp(`## ${phase}([\\s\\S]*?)(?=\\n## |$)`);
    const match = content.match(re);
    expect(match, `section ${phase} not found`).toBeTruthy();
    expect(match![1]).toContain(queue);
  });

  it('Day 6-13 section enables bug → feature → design in order', () => {
    const re = /## Day 6-13[\s\S]*?(?=\n## |$)/;
    const match = content.match(re);
    expect(match, 'Day 6-13 section not found').toBeTruthy();
    const section = match![0];
    const bugPos = section.indexOf('queue:bug');
    const featurePos = section.indexOf('queue:feature');
    const designPos = section.indexOf('queue:design');
    expect(bugPos, 'queue:bug should appear in Day 6-13').toBeGreaterThan(-1);
    expect(featurePos, 'queue:feature should appear in Day 6-13').toBeGreaterThan(-1);
    expect(designPos, 'queue:design should appear in Day 6-13').toBeGreaterThan(-1);
    expect(bugPos, 'bug before feature').toBeLessThan(featurePos);
    expect(featurePos, 'feature before design').toBeLessThan(designPos);
  });

  it('Day 14+ section includes guard for already-absent auto-update-prs.yml', () => {
    const sections = content.split(/^## /m);
    const day14Section = sections.find((s) => s.startsWith('Day 14+'));
    expect(day14Section, 'Day 14+ section not found').toBeTruthy();
    const section = 'Day 14+' + day14Section!;
    expect(section).toContain('auto-update-prs.yml');
    expect(section).toMatch(/already absent|no-op|\[ -f/i);
  });

  it('cookbook does NOT recommend setting `disabled: false` (the field is invalid in Mergify v1)', () => {
    // Catches a regression where someone resurrects the pre-S20-32 mechanism.
    expect(content).not.toMatch(/disabled:\s*false/);
    expect(content).not.toMatch(/disabled:\s*true/);
  });

  it('cookbook documents the new comment-out enable mechanism', () => {
    // Each queue-enable phase should mention uncommenting the block and adding
    // to queue_rules. The exact phrasing is intentionally not pinned — assert
    // the operative verbs/keywords appear at least once.
    expect(content).toMatch(/uncomment/i);
    expect(content).toMatch(/queue_rules/);
  });

  it('each queue-enable phase shows the active YAML to add', () => {
    // Five queues to enable × at least one ```yaml block each + Day-14 retire.
    // Loose lower bound: at least 5 yaml fences in the file.
    const yamlBlocks = content.match(/```yaml/g) ?? [];
    expect(yamlBlocks.length, 'expected at least 5 ```yaml blocks (one per queue enable)').toBeGreaterThanOrEqual(5);
  });

  it('cookbook references the post-enable Mergify API validation', () => {
    // Operators should know how to confirm Mergify accepted the new config.
    // String match (not regex) — CodeQL flagged the unanchored regex form,
    // and a literal substring check is equivalent here.
    expect(content).toContain('api.mergify.com');
    expect(content).toContain('queues');
  });
});
