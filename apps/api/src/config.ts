import { LogLevel } from '@nestjs/common';
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

const LOG_LEVELS: Record<string, LogLevel[]> = {
  debug: ['error', 'warn', 'log', 'debug', 'verbose'],
  info: ['error', 'warn', 'log'],
  warn: ['error', 'warn'],
  error: ['error'],
};
const logLevel = (process.env.LOG_LEVEL || 'info').trim().toLowerCase();
if (!LOG_LEVELS[logLevel]) throw new Error(`Invalid LOG_LEVEL ${logLevel}, expected debug|info|warn|error`);

export type ModelEntry = { id: string; label: string; model: string; multiplier: number };

// LLM_MODELS: JSON [{id,label,model,multiplier}], first = default. Unset -> single 'default' entry. Set but invalid -> throws.
export function parseModels(raw: string | undefined, fallbackModel: string | undefined): ModelEntry[] {
  if (!raw?.trim()) return [{ id: 'default', label: 'Default', model: fallbackModel || 'default', multiplier: 1 }];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('LLM_MODELS is not valid JSON');
  }
  if (!Array.isArray(list) || !list.length) throw new Error('LLM_MODELS must be a non-empty array');
  const seen = new Set<string>();
  for (const e of list as Record<string, unknown>[]) {
    const ok =
      e && typeof e === 'object' &&
      typeof e.id === 'string' && /^[a-z0-9-]{1,32}$/.test(e.id) &&
      typeof e.label === 'string' && e.label.trim() &&
      typeof e.model === 'string' && e.model.trim() &&
      typeof e.multiplier === 'number' && e.multiplier > 0 && e.multiplier <= 100;
    if (!ok) throw new Error('LLM_MODELS has an invalid entry');
    if (seen.has(e.id as string)) throw new Error('LLM_MODELS has a duplicate id');
    seen.add(e.id as string);
  }
  return list as ModelEntry[];
}

export const config = {
  models: parseModels(process.env.LLM_MODELS, process.env.LLM_MODEL),
  webOrigin: need('WEB_ORIGIN'),
  logLevel,
  logLevels: LOG_LEVELS[logLevel],
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
  // RESEND_API_KEY switches email to Resend's HTTPS API; otherwise SMTP_URL is required
  resendApiKey: process.env.RESEND_API_KEY || null,
  smtpUrl: process.env.RESEND_API_KEY ? process.env.SMTP_URL || null : need('SMTP_URL'),
  mailFrom: need('MAIL_FROM'),
  google: process.env.GOOGLE_CLIENT_ID
    ? {
        clientId: need('GOOGLE_CLIENT_ID'),
        clientSecret: need('GOOGLE_CLIENT_SECRET'),
        callbackUrl: need('GOOGLE_CALLBACK_URL'),
      }
    : null,
};
