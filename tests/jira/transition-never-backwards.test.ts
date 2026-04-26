/**
 * a3: never-backwards — refuses transitions targeting an earlier kanban state.
 * Covers all 4 backward edges from kanban-states.md §Backward edges.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPT = scriptPath('transition.sh');

// Forward order (index 0 = earliest):
// Idea(0) Backlog(1) Planning(2) Plan Review(3) Ready to Dev(4)
// In Development(5) PR Review(6) Merge Queue(7) UAT(8) Done(9)
// Backward edges from kanban-states.md:
const BACKWARD_EDGES = [
  { from: 'Plan Review',     to: 'Planning' },
  { from: 'PR Review',       to: 'In Development' },
  { from: 'Merge Queue',     to: 'PR Review' },
  { from: 'UAT',             to: 'PR Review' },
];

describe('transition.sh — never-backwards (a3)', () => {
  let tmpDir: string;
  let stub: StubServer;
  let envFile: string;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    stub = await createStubJira();
    envFile = makeJiraEnvFile(tmpDir, { JIRA_BASE_URL: `http://127.0.0.1:${stub.port}` });
  });

  afterEach(async () => {
    await stub.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const edge of BACKWARD_EDGES) {
    it(`refuses ${edge.from} → ${edge.to} (zero POST, "refused: backward transition")`, async () => {
      stub.setRoute('GET', '/rest/api/3/issue/SCRUM-1', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ fields: { status: { name: edge.from } } }));
      });

      const result = await runScript(SCRIPT, [
        '--project', 'SCRUM',
        '--ticket', 'SCRUM-1',
        '--to', edge.to,
        '--reason', 'test backward'
      ], {
        JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
        JIRA_ENV_FILE: envFile,
        JIRA_RETRY_QUEUE: path.join(tmpDir, 'retry.json')
      });

      expect(result.exitCode).toBe(0);

      const posts = stub.requests.filter((r) => r.method === 'POST');
      expect(posts.length).toBe(0);

      expect(result.stdout).toMatch(/refused: backward transition/i);
    });
  }
});
