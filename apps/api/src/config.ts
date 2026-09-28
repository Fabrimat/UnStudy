import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// pnpm runs scripts with cwd = apps/api, so the repo-root .env is two levels up.
// loadEnvFile never overrides variables that are already set (tests, e2e, production).
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

export const config = {
  webOrigin: need('WEB_ORIGIN'),
  s3: {
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: need('S3_REGION'),
    bucket: need('S3_BUCKET'),
    accessKeyId: need('S3_ACCESS_KEY_ID'),
    secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    // comma-separated origins allowed to upload from the browser; when set, applied to the bucket at startup
    corsOrigins: (process.env.S3_CORS_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  },
  smtpUrl: need('SMTP_URL'),
  mailFrom: need('MAIL_FROM'),
  google: process.env.GOOGLE_CLIENT_ID
    ? {
        clientId: need('GOOGLE_CLIENT_ID'),
        clientSecret: need('GOOGLE_CLIENT_SECRET'),
        callbackUrl: need('GOOGLE_CALLBACK_URL'),
      }
    : null,
};
