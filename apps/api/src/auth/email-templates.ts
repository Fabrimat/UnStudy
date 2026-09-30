// Code-side registry: a DB row (EmailTemplate) overrides the default, no row = default.
export type TemplateDef = {
  placeholders: { name: string; required: boolean }[];
  subject: string;
  body: string;
  sample: Record<string, string>;
};

export const EMAIL_TEMPLATES: Record<string, TemplateDef> = {
  magic_link: {
    placeholders: [{ name: 'link', required: true }, { name: 'email', required: false }],
    subject: 'Your Summarize login link',
    body: 'Open this link to log in (valid for 15 minutes):\n\n{link}\n\nIf you did not ask for it, ignore this email.',
    sample: { link: 'https://example.com/auth/verify?token=example', email: 'ada@example.com' },
  },
  purchase_receipt: {
    placeholders: [{ name: 'credits', required: true }, { name: 'balance', required: false }, { name: 'email', required: false }],
    subject: 'Your Summarize purchase',
    body: 'Thank you! {credits} credits were added to your account. Your balance is now {balance} credits.',
    sample: { credits: '100', balance: '140', email: 'ada@example.com' },
  },
  job_failed: {
    placeholders: [{ name: 'filename', required: true }, { name: 'credits', required: false }, { name: 'link', required: false }, { name: 'email', required: false }],
    subject: 'Your summary of {filename} failed',
    body: 'Sorry, the summary of {filename} could not be completed. {credits} credits were refunded to your account.\n\nDetails: {link}',
    sample: { filename: 'report.pdf', credits: '12', link: 'https://example.com/jobs/example', email: 'ada@example.com' },
  },
};

const TOKEN = /\{(\w+)\}/g;

export const tokensOf = (text: string) => [...text.matchAll(TOKEN)].map((m) => m[1]);

// Single pass: substituted values are never re-scanned. Unknown tokens stay as written.
export const fill = (text: string, vars: Record<string, string>) => text.replace(TOKEN, (m, name) => vars[name] ?? m);
