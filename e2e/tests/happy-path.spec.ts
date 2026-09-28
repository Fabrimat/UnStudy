import { APIRequestContext, expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E_ENV } from '../playwright.config';

async function loginLink(request: APIRequestContext, email: string) {
  for (let i = 0; i < 40; i++) {
    const search = await (await request.get(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (search.messages?.length) {
      const message = await (await request.get(`http://localhost:8025/api/v1/message/${search.messages[0].ID}`)).json();
      return /(http\S+token=[\w-]+)/.exec(message.Text)![1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no login email for ${email}`);
}

test('login, upload, summarize and download', async ({ page, request }) => {
  const email = `e2e-${Date.now()}@example.com`;
  execSync(`pnpm --filter @summarize/api grant ${email} 50`, { env: { ...process.env, ...E2E_ENV }, stdio: 'inherit' });

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send login link' }).click();
  await expect(page.getByText('Check your inbox')).toBeVisible();

  await page.goto(await loginLink(request, email));
  await expect(page.getByTestId('balance')).toHaveText('50 credits');

  await page.locator('input[type=file]').setInputFiles(resolve(__dirname, '../fixtures/sample.pdf'));
  await page.getByRole('link', { name: 'sample.pdf' }).click();
  await expect(page.getByRole('button', { name: 'Start summary' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Cost: 1 credits')).toBeVisible();
  await page.getByRole('button', { name: 'Start summary' }).click();

  await expect(page.getByText('Done')).toBeVisible({ timeout: 60_000 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download .md' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('sample - Summary.md');
  expect(readFileSync(await download.path(), 'utf8')).toContain('# Fake Summary');
  await expect(page.getByTestId('balance')).toHaveText('49 credits');
});
