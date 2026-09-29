// Must match apps/worker/summarize_worker/prompts.py
export const LANGUAGES = ['auto', 'en', 'it', 'nl', 'fr', 'de', 'es'] as const;
export const FRACTIONS = [3, 5, 10] as const; // legacy, preferences only
export const EXTRAS = ['glossary', 'questions', 'takeaways'] as const;
export const LENGTH_MIN = 5;
export const LENGTH_MAX = 50;
export const PRESETS = ['studio', 'schematico', 'abstract'] as const;
export const MAX_ACTIVE_SUMMARIES = 3;
export const MAX_METHODS = 20;
// A job/preference "method" is a system preset or one of the user's own methods.
export const METHOD_RE = new RegExp(`^(${PRESETS.join('|')}|custom:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$`);
export const METHOD_MESSAGE = 'method must be a preset or custom:<id>';
