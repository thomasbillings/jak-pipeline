/**
 * Stub Jira HTTP server for tests.
 * Spins up a Node http.createServer on 127.0.0.1:0 (random ephemeral port).
 * Tests configure route handlers and inspect recorded requests.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, type SpawnOptions } from 'node:child_process';

export interface StubRequest {
  method: string;
  url: string;
  body: string;
}

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => void;

export interface StubServer {
  port: number;
  requests: StubRequest[];
  setRoute(method: string, path: string, handler: RouteHandler): void;
  setDefaultResponse(statusCode: number, body: string): void;
  close(): Promise<void>;
}

export function createStubJira(): Promise<StubServer> {
  return new Promise((resolve) => {
    const requests: StubRequest[] = [];
    const routes = new Map<string, RouteHandler>();
    let defaultStatusCode = 200;
    let defaultBody = '{}';

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body });

        const key = `${req.method}:${req.url}`;
        const handler = routes.get(key);
        if (handler) {
          handler(req, res);
        } else {
          res.writeHead(defaultStatusCode, { 'Content-Type': 'application/json' });
          res.end(defaultBody);
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };

      resolve({
        port: addr.port,
        requests,
        setRoute(method, urlPath, handler) {
          routes.set(`${method}:${urlPath}`, handler);
        },
        setDefaultResponse(statusCode, body) {
          defaultStatusCode = statusCode;
          defaultBody = body;
        },
        close() {
          return new Promise((res, rej) => server.close((err) => (err ? rej(err) : res())));
        }
      });
    });
  });
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ScriptEnv {
  JIRA_BASE_URL: string;
  JIRA_EMAIL?: string;
  JIRA_API_TOKEN?: string;
  JIRA_PROJECT?: string;
  JIRA_ENV_FILE?: string;
  JIRA_RETRY_QUEUE?: string;
  JIRA_BACKOFF_SEED_MS?: string;
  JIRA_BACKOFF_CAP_MS?: string;
  DOWNSTREAM_ROOT?: string;
  [key: string]: string | undefined;
}

export function runScript(
  scriptPath: string,
  args: string[],
  env: ScriptEnv
): Promise<RunResult> {
  return new Promise((resolve) => {
    const spawnEnv = {
      ...process.env,
      ...env,
      // Remove undefined values
      ...Object.fromEntries(
        Object.entries(env).filter(([, v]) => v !== undefined)
      )
    };

    const child = spawn('bash', [scriptPath, ...args], {
      env: spawnEnv as NodeJS.ProcessEnv
    } as SpawnOptions);

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

export function scriptPath(name: string): string {
  // Resolve from the repo root (two levels up from tests/jira/)
  const repoRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../..'
  );
  return path.join(repoRoot, 'scripts', 'jira', name);
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jak-test-'));
}

export function makeJiraEnvFile(dir: string, overrides: Partial<Record<string, string>> = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const envPath = path.join(dir, 'jira.env');
  const vars = {
    JIRA_BASE_URL: 'http://placeholder',
    JIRA_EMAIL: 'test@example.com',
    JIRA_API_TOKEN: 'fake-token',
    JIRA_PROJECT: 'SCRUM',
    ...overrides
  };
  const content = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
  fs.writeFileSync(envPath, content);
  return envPath;
}
