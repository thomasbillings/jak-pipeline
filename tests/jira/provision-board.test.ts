/**
 * a7: provision-board.sh — idempotent board provisioning.
 * Adds missing columns; never deletes extras.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStubJira, runScript, scriptPath, makeTempDir, makeJiraEnvFile, type StubServer } from './_stub-jira.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as http from 'node:http';

const SCRIPT = scriptPath('provision-board.sh');

// The 12 canonical states from kanban-states.md
const CANONICAL_STATES = [
  'Idea', 'Backlog', 'Planning', 'Plan Review', 'Ready to Dev',
  'In Development', 'PR Review', 'Merge Queue', 'UAT', 'Done',
  'Blocked', 'Cancelled'
];

describe('provision-board.sh — idempotent provisioning (a7)', () => {
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

  it('creates 12 columns when board has 0 existing columns', async () => {
    const created: string[] = [];

    stub.setRoute('GET', '/rest/agile/1.0/board/42/configuration', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ columnConfig: { columns: [] } }));
    });

    stub.setRoute('POST', '/rest/agile/1.0/board/42/configuration/column', (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        try { created.push(JSON.parse(body).name); } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: Math.floor(Math.random() * 9999) }));
      });
    });

    const result = await runScript(SCRIPT, [
      '--project', 'SCRUM',
      '--board', '42'
    ], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile
    });

    expect(result.exitCode).toBe(0);
    expect(created.length).toBe(12);
    for (const state of CANONICAL_STATES) {
      expect(created).toContain(state);
    }
  });

  it('is a no-op (zero POST/PUT) when all 12 columns already exist', async () => {
    stub.setRoute('GET', '/rest/agile/1.0/board/42/configuration', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        columnConfig: {
          columns: CANONICAL_STATES.map((name) => ({ name }))
        }
      }));
    });

    await runScript(SCRIPT, ['--project', 'SCRUM', '--board', '42'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile
    });

    const writes = stub.requests.filter((r) => r.method === 'POST' || r.method === 'PUT');
    expect(writes.length).toBe(0);
  });

  it('leaves extra columns untouched (never deletes) when 14 columns exist', async () => {
    const existingColumns = [
      ...CANONICAL_STATES,
      'Custom Column A',
      'Custom Column B'
    ];

    stub.setRoute('GET', '/rest/agile/1.0/board/42/configuration', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        columnConfig: { columns: existingColumns.map((name) => ({ name })) }
      }));
    });

    const result = await runScript(SCRIPT, ['--project', 'SCRUM', '--board', '42'], {
      JIRA_BASE_URL: `http://127.0.0.1:${stub.port}`,
      JIRA_ENV_FILE: envFile
    });

    expect(result.exitCode).toBe(0);

    const deletes = stub.requests.filter((r) => r.method === 'DELETE');
    const posts = stub.requests.filter((r) => r.method === 'POST');
    const puts = stub.requests.filter((r) => r.method === 'PUT');

    expect(deletes.length).toBe(0);
    expect(posts.length).toBe(0);
    expect(puts.length).toBe(0);
  });
});
