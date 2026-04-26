import type { Cache } from './cache.js';
import type { MergifyClient } from './server.js';

interface MergifyClientConfig {
  apiKey: string;
  org: string;
  githubToken?: string;
}

function getConfig(): MergifyClientConfig {
  const apiKey = process.env['MERGIFY_API_KEY'];
  const org = process.env['MERGIFY_ORG'];
  if (!apiKey || !org) {
    throw new Error('MERGIFY_API_KEY and MERGIFY_ORG environment variables are required');
  }
  return { apiKey, org, githubToken: process.env['GITHUB_TOKEN'] };
}

export function createMergifyClient(cache: Cache): MergifyClient {
  const config = getConfig();
  const baseUrl = `https://api.mergify.com/v1/repos/${config.org}`;
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };

  async function request(path: string, options?: RequestInit): Promise<unknown> {
    const resp = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...headers, ...options?.headers } });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Mergify API error ${resp.status}: ${body}`);
    }
    return resp.json();
  }

  return {
    getQueueSummary() {
      return cache.getOrSet('queue_summary', 30_000, () => request('/queues'));
    },
    getQueueDetails(pr: number) {
      return request(`/queue/pulls/${pr}`);
    },
    checkPrEligibility(pr: number) {
      return request(`/queue/pulls/${pr}/eligibility`);
    },
    listQueueFreezes() {
      return cache.getOrSet('queue_freezes', 60_000, () => request('/queue/freeze'));
    },
    async setQueueState(state: string, reason: string) {
      if (state !== 'locked' && state !== 'unlocked') {
        throw new Error(`setQueueState: invalid state "${state}" — must be "locked" or "unlocked"`);
      }
      const result = await request('/queue/freeze', {
        method: state === 'locked' ? 'PUT' : 'DELETE',
        body: JSON.stringify({ reason }),
      });
      // Invalidate freeze cache — state just changed
      cache.clear();
      return result;
    },
    async replayPr(pr: number, reason: string) {
      const result = await request(`/queue/pulls/${pr}/replay`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      // Invalidate summary cache — queue state just changed
      cache.clear();
      return result;
    },
  };
}
