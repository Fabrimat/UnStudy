import { execSync } from 'node:child_process';

// ponytail: `prisma migrate reset` is destructive and blocked for AI agents;
// `migrate deploy` is non-destructive and sufficient since the schema is
// already migrated. Per-test isolation is handled by resetDb() (TRUNCATE).
export default function globalSetup() {
  execSync('pnpm --filter @summarize/db exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'postgresql://summarize:summarize@localhost:5432/summarize_test_api' },
  });
}
