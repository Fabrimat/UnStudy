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

export type ProviderEntry = {
  id: string;
  kind: 'openai';
  baseUrl: string;
  apiKeyEnv?: string;
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  maxConcurrency?: number;
};

const ID_RE = /^[a-z0-9-]{1,32}$/;
const isObj = (e: unknown): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e);

// LLM_PROVIDERS: JSON [{id,kind?,baseUrl,apiKeyEnv?,tokenParam?,maxConcurrency?}]. Unset -> single 'default' provider (LLM_BASE_URL).
// The API never reads keys; errors name the field, never a value.
export function parseProviders(raw: string | undefined, env: NodeJS.ProcessEnv = process.env): ProviderEntry[] {
  if (!raw?.trim()) return [{ id: 'default', kind: 'openai', baseUrl: env.LLM_BASE_URL ?? '', tokenParam: 'max_tokens' }];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('LLM_PROVIDERS is not valid JSON');
  }
  if (!Array.isArray(list) || !list.length) throw new Error('LLM_PROVIDERS must be a non-empty array');
  const seen = new Set<string>();
  return list.map((e: unknown, i) => {
    const bad = (why: string) => new Error(`LLM_PROVIDERS entry ${i}: ${why}`);
    if (!isObj(e)) throw bad('must be an object');
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) throw bad('invalid id (a-z, 0-9, dash, max 32)');
    if (seen.has(e.id)) throw bad('duplicate id');
    seen.add(e.id);
    if (e.kind !== undefined && e.kind !== 'openai') throw bad('kind must be "openai"');
    if (typeof e.baseUrl !== 'string' || !e.baseUrl.trim()) throw bad('baseUrl must be a non-empty string');
    if (e.apiKeyEnv !== undefined && (typeof e.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.apiKeyEnv))) throw bad('apiKeyEnv must be an env var name');
    if (e.tokenParam !== undefined && e.tokenParam !== 'max_tokens' && e.tokenParam !== 'max_completion_tokens') throw bad('tokenParam must be max_tokens or max_completion_tokens');
    if (e.maxConcurrency !== undefined && (typeof e.maxConcurrency !== 'number' || !Number.isInteger(e.maxConcurrency) || e.maxConcurrency < 1 || e.maxConcurrency > 64)) throw bad('maxConcurrency must be an integer 1..64');
    return {
      id: e.id,
      kind: 'openai' as const,
      baseUrl: e.baseUrl,
      ...(e.apiKeyEnv !== undefined && { apiKeyEnv: e.apiKeyEnv as string }),
      tokenParam: (e.tokenParam as ProviderEntry['tokenParam'] | undefined) ?? 'max_tokens',
      ...(e.maxConcurrency !== undefined && { maxConcurrency: e.maxConcurrency as number }),
    };
  });
}

export type ModelEntry = {
  id: string;
  label: string;
  model: string;
  multiplier: number;
  provider: string;
  temperature: number | null;
  priceIn?: number;
  priceOut?: number;
  adminOnly: boolean;
};

// LLM_MODELS: JSON [{id,label,model,multiplier,provider?,temperature?,priceIn?,priceOut?,adminOnly?}]. Unset -> single 'default' entry.
// Set but invalid -> throws. Default for user jobs = first non-adminOnly entry (config.userModels[0]).
export function parseModels(raw: string | undefined, fallbackModel: string | undefined, providers: { id: string }[] = [{ id: 'default' }]): ModelEntry[] {
  if (!raw?.trim()) {
    return [{ id: 'default', label: 'Default', model: fallbackModel || 'default', multiplier: 1, provider: providers[0].id, temperature: 0.4, adminOnly: false }];
  }
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('LLM_MODELS is not valid JSON');
  }
  if (!Array.isArray(list) || !list.length) throw new Error('LLM_MODELS must be a non-empty array');
  const seen = new Set<string>();
  const price = (v: unknown) => v === undefined || (typeof v === 'number' && v >= 0 && Number.isFinite(v));
  const entries = list.map((e: unknown, i): ModelEntry => {
    const bad = (why: string) => new Error(`LLM_MODELS entry ${i}: ${why}`);
    if (!isObj(e)) throw bad('must be an object');
    const ok =
      typeof e.id === 'string' && ID_RE.test(e.id) &&
      typeof e.label === 'string' && e.label.trim() &&
      typeof e.model === 'string' && e.model.trim() &&
      typeof e.multiplier === 'number' && e.multiplier > 0 && e.multiplier <= 100;
    if (!ok) throw bad('invalid id, label, model or multiplier');
    if (seen.has(e.id as string)) throw bad('duplicate id');
    seen.add(e.id as string);
    if (e.provider !== undefined && (typeof e.provider !== 'string' || !providers.some((p) => p.id === e.provider))) throw bad('unknown provider');
    if (e.temperature !== undefined && e.temperature !== null && (typeof e.temperature !== 'number' || !(e.temperature >= 0 && e.temperature <= 2))) throw bad('temperature must be a number 0..2 or null');
    if (!price(e.priceIn) || !price(e.priceOut)) throw bad('priceIn/priceOut must be numbers >= 0');
    if (e.adminOnly !== undefined && typeof e.adminOnly !== 'boolean') throw bad('adminOnly must be a boolean');
    return {
      id: e.id as string,
      label: e.label as string,
      model: e.model as string,
      multiplier: e.multiplier as number,
      provider: (e.provider as string | undefined) ?? providers[0].id,
      temperature: e.temperature === undefined ? 0.4 : (e.temperature as number | null),
      ...(e.priceIn !== undefined && { priceIn: e.priceIn as number }),
      ...(e.priceOut !== undefined && { priceOut: e.priceOut as number }),
      adminOnly: e.adminOnly === true,
    };
  });
  if (entries.every((m) => m.adminOnly)) throw new Error('LLM_MODELS needs at least one entry that is not adminOnly');
  return entries;
}

export type Pack = { id: string; credits: number; priceId: string };

// STRIPE_PACKS: JSON [{id,credits,priceId}]. Price and currency are read from Stripe; credits stay ours.
export function parsePacks(raw: string | undefined): Pack[] {
  let list: unknown;
  try {
    list = JSON.parse(raw ?? '');
  } catch {
    throw new Error('STRIPE_PACKS is not valid JSON');
  }
  if (!Array.isArray(list) || !list.length) throw new Error('STRIPE_PACKS must be a non-empty array');
  const seen = new Set<string>();
  for (const e of list as Record<string, unknown>[]) {
    const ok =
      e && typeof e === 'object' &&
      typeof e.id === 'string' && /^[a-z0-9-]{1,32}$/.test(e.id) &&
      typeof e.credits === 'number' && Number.isInteger(e.credits) && e.credits >= 1 && e.credits <= 100000 &&
      typeof e.priceId === 'string' && e.priceId.trim();
    if (!ok) throw new Error('STRIPE_PACKS has an invalid entry');
    if (seen.has(e.id as string)) throw new Error('STRIPE_PACKS has a duplicate id');
    seen.add(e.id as string);
  }
  return list as Pack[];
}

// Billing is optional: no STRIPE_SECRET_KEY -> null. With a key, webhook secret and packs are mandatory (fail fast).
export function parseStripe(env: NodeJS.ProcessEnv) {
  if (!env.STRIPE_SECRET_KEY) return null;
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: need('STRIPE_WEBHOOK_SECRET'),
    packs: parsePacks(env.STRIPE_PACKS),
    automaticTax: env.STRIPE_AUTOMATIC_TAX === 'true',
  };
}

const providers = parseProviders(process.env.LLM_PROVIDERS, process.env);
const models = parseModels(process.env.LLM_MODELS, process.env.LLM_MODEL, providers);

export const config = {
  stripe: parseStripe(process.env),
  providers,
  models,
  // Users only see/pick non-adminOnly models; the first one is their default.
  userModels: models.filter((m) => !m.adminOnly),
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
