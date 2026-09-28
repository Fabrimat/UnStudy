import { Job } from '@summarize/db';

// Never expose warnings, token counts or S3 keys to the browser.
export function toJobDto(job: Job) {
  const { id, documentId, kind, options, status, progress, phase, credits, error, createdAt, finishedAt } = job;
  return { id, documentId, kind, options, status, progress, phase, credits, error, createdAt, finishedAt };
}
