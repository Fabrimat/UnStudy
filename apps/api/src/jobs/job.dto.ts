import { Job } from '@summarize/db';

// Never expose warnings, token counts or S3 keys to the browser.
export function toJobDto(job: Job) {
  const { id, documentId, kind, options, status, progress, phase, credits, error, createdAt, finishedAt } = job;
  // customInstructions is only for the worker; the text is already visible in /methods.
  const { customInstructions: _, ...publicOptions } = options as Record<string, unknown>;
  return { id, documentId, kind, options: publicOptions, status, progress, phase, credits, error, createdAt, finishedAt };
}
