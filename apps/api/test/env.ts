process.env.DATABASE_URL = 'postgresql://summarize:summarize@localhost:5432/summarize_test_api';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_REGION = 'us-east-1';
process.env.S3_BUCKET = 'summarize-test';
process.env.S3_ACCESS_KEY_ID = 'summarize';
process.env.S3_SECRET_ACCESS_KEY = 'summarize-secret';
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.SMTP_URL = 'smtp://localhost:1025';
process.env.MAIL_FROM = 'Summarize <no-reply@summarize.local>';
process.env.GOOGLE_CLIENT_ID ??= '';
// Pin the catalogue: the repo-root .env may hold a real LLM_MODELS, and config only fills unset vars. Specs that need
// another catalogue (admin-env.ts) overwrite these before importing src/config.
process.env.LLM_PROVIDERS = '';
process.env.LLM_MODELS = '';
process.env.LLM_MODEL = 'test-model';
