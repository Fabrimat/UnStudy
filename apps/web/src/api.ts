import { useQuery } from '@tanstack/react-query';

export type Me = { id: string; email: string; name: string | null; balance: number };
export type Chapter = { title: string; pageFrom: number | null; pageTo: number | null; words: number };
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type Job = {
  id: string; documentId: string; kind: 'analyze' | 'summarize'; options: Record<string, unknown>;
  status: JobStatus; progress: number; phase: string; credits: number; error: string | null;
  createdAt: string; finishedAt: string | null;
};
export type Doc = {
  id: string; filename: string; sizeBytes: number; status: 'uploaded' | 'analyzed' | 'rejected';
  rejectReason: string | null; pages: number | null; words: number | null; chapters: Chapter[] | null;
  credits: number | null; createdAt: string; jobs: Job[];
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) {
    super(message);
  }
}

export async function api<T = void>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message ?? res.statusText;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });

export async function uploadFile(file: File) {
  const { document, uploadUrl } = await api<{ document: Doc; uploadUrl: string }>('/documents', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, sizeBytes: file.size }),
  });
  const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/pdf' } });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  await api(`/documents/${document.id}/uploaded`, { method: 'POST' });
}
