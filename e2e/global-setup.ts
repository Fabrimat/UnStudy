import { execSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E_DB, E2E_ENV } from './playwright.config';

const python = process.env.PYTHON ?? 'python';

export default async function globalSetup() {
  // ponytail: `prisma migrate reset` is destructive and blocked for AI agents;
  // `migrate deploy` is non-destructive and sufficient since the schema is
  // already migrated. Test isolation comes from a unique email per run.
  execSync('pnpm --filter @summarize/db exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: E2E_DB },
  });
  execSync(`${python} ${resolve(__dirname, 'make_fixture.py')}`, { stdio: 'inherit' });
  const worker = spawn(python, ['-m', 'summarize_worker'], {
    cwd: resolve(__dirname, '../apps/worker'),
    env: { ...process.env, ...E2E_ENV },
    stdio: 'inherit',
  });
  writeFileSync(resolve(__dirname, '.worker.pid'), String(worker.pid));
}
