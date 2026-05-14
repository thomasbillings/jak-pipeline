import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: './tests/_global-setup.ts',
    testTimeout: 30000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['scripts/jira/**/*.sh', 'scripts/uat/**/*.sh'],
      thresholds: {
        lines: 80
      }
    }
  }
});
