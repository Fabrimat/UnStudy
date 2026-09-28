// Must match apps/worker/summarize_worker/prompts.py
export const LANGUAGES = ['auto', 'en', 'it', 'nl', 'fr', 'de', 'es'] as const;
export const FRACTIONS = [3, 5, 10] as const;
export const PRESETS = ['studio', 'schematico', 'abstract'] as const;
export const MAX_ACTIVE_SUMMARIES = 3;
