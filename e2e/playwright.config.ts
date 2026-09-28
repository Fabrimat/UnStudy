import { defineConfig } from '@playwright/test';

export const E2E_DB = 'postgresql://summarize:summarize@localhost:5432/summarize_test_e2e';
export const E2E_ENV = {
  DATABASE_URL: E2E_DB,
  S3_BUCKET: 'summarize-test',
  WEB_ORIGIN: 'http://localhost:5174',
  PORT: '3100',
  API_URL: 'http://localhost:3100',
  GOOGLE_CLIENT_ID: '',
  LLM_BASE_URL: 'fake',
  LLM_MODEL: 'fake',
};

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  workers: 1,
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: { baseURL: 'http://localhost:5174', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm --filter @summarize/api dev',
      url: 'http://localhost:3100/api/health',
      env: E2E_ENV,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @summarize/web dev --port 5174 --strictPort',
      url: 'http://localhost:5174',
      env: E2E_ENV,
      reuseExistingServer: false,
    },
  ],
});
