import { useQuery } from '@tanstack/react-query';

export type Preferences = { language?: string; lengthPercent?: number; method?: string; model?: string; fraction?: number /* legacy */ };
export type Model = { id: string; label: string; multiplier: number };
export type Extra = 'glossary' | 'questions' | 'takeaways';
export type Me = { id: string; email: string; name: string | null; balance: number; preferences: Preferences };
export type Method = { id: string; name: string; instructions: string; createdAt: string; updatedAt: string };
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
  credits: number | null; createdAt: string; jobs: Job[]; analysisQueued: boolean; fileDeleted: boolean;
};
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
export type JobWithDoc = Job & { document: { id: string; filename: string } };
export type LedgerEntry = { id: string; type: string; amount: number; createdAt: string; jobId: string | null; filename: string | null };
export type Pack = { id: string; credits: number; amount: number; currency: string };
export type BillingPacks = { enabled: boolean; packs: Pack[] };
export type Stats = { documents: number; summariesDone: number; creditsSpent: number; pagesSummarized: number };

export const formatPrice = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100);

// Builds "?a=1&b=2", skipping empty values.

export const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const LANGUAGES = [['auto', 'Same as the document'], ['en', 'English'], ['it', 'Italian'], ['nl', 'Dutch'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish']] as const;
export const QUICK_LENGTHS = [[33, '1/3'], [20, '1/5'], [10, '1/10']] as const;
export const EXTRAS = [['glossary', 'Glossary'], ['questions', 'Review questions'], ['takeaways', 'Key takeaways']] as const;

const WORDS_PER_CREDIT = 1000;
// Same integer arithmetic as the API, to avoid ceil(11.000000000000002).
export const creditsForJob = (words: number, multiplier = 1) =>
  Math.max(1, Math.ceil((Math.max(1, Math.ceil(words / WORDS_PER_CREDIT)) * Math.round(multiplier * 100)) / 100));

// Length of a job: "N%", or "1/N" for old jobs that only have options.fraction.
export const lengthLabel = (o: Record<string, unknown>) =>
  o.lengthPercent ? `${o.lengthPercent}%` : o.fraction ? `1/${o.fraction}` : '';

// Saved length preference: lengthPercent, else legacy fraction, else 33.
export const lengthOf = (p?: Preferences) => p?.lengthPercent ?? (p?.fraction ? Math.round(100 / p.fraction) : 33);

export const modelOptions = (models: Model[] = []) =>
  models.map((m) => [m.id, m.multiplier !== 1 ? `${m.label} (×${m.multiplier})` : m.label] as const);
export const PRESETS = [['studio', 'Study summary (continuous prose)'], ['schematico', 'Structured notes (bullet points)'], ['abstract', 'Short abstract']] as const;

// Style select options: optional leading entries, the 3 presets, then the user's custom methods.
export const styleOptions = (methods: Method[] = [], first: readonly (readonly [string, string])[] = []) =>
  [...first, ...PRESETS, ...methods.map((m) => [`custom:${m.id}`, m.name] as const)] as readonly (readonly [string, string])[];

// Label of a job's style; old jobs only have options.preset.
export function methodLabel(options: Record<string, unknown>, methods: Method[] = []) {
  const id = String(options.method ?? options.preset ?? '');
  const preset = PRESETS.find(([v]) => v === id);
  if (preset) return preset[1];
  if (typeof options.methodName === 'string') return options.methodName;
  return methods.find((m) => `custom:${m.id}` === id)?.name ?? 'Custom (deleted)';
}

export const pageCount = (p: Page<unknown>) => Math.max(1, Math.ceil(p.total / p.pageSize));

const UPLOAD_TIMEOUT_MS = 15 * 60_000;

// An interrupted upload (PUT or confirm never happened) never gets an analyze job, so the
// document is stuck "uploaded" forever instead of moving on to "Analyzing…" (F3).
export const uploadFailed = (d: Doc) =>
  d.status === 'uploaded' && !d.analysisQueued && Date.now() - new Date(d.createdAt).getTime() > UPLOAD_TIMEOUT_MS;

export const busy = (d: Doc) =>
  (d.status === 'uploaded' && !uploadFailed(d)) || d.jobs.some((j) => j.status === 'queued' || j.status === 'running');

export function docStatus(d: Doc) {
  if (d.status === 'uploaded') return uploadFailed(d) ? 'Upload failed — please upload the file again' : 'Analyzing…';
  if (d.status === 'rejected') return `Rejected: ${d.rejectReason}`;
  const job = d.jobs[0];
  if (!job) return `${d.pages} pages · ${d.credits} credits`;
  if (job.status === 'done') return 'Done';
  if (job.status === 'failed') return 'Failed';
  return `${job.progress}%`;
}

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

export const useMethods = () => useQuery({ queryKey: ['methods'], queryFn: () => api<Method[]>('/methods') });

export const useModels = () => useQuery({ queryKey: ['models'], queryFn: () => api<Model[]>('/models') });

export const usePacks = () => useQuery({ queryKey: ['packs'], queryFn: () => api<BillingPacks>('/billing/packs') });

export async function uploadFile(file: File) {
  const { document, uploadUrl } = await api<{ document: Doc; uploadUrl: string }>('/documents', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, sizeBytes: file.size }),
  });
  const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/pdf' } });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  await api(`/documents/${document.id}/uploaded`, { method: 'POST' });
}
