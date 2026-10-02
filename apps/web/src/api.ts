import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fmt, t } from './i18n';

export type Preferences = { language?: string; lengthPercent?: number; method?: string; model?: string; fraction?: number /* legacy */ };
export type Model = { id: string; label: string; multiplier: number };
export type Extra = 'glossary' | 'questions' | 'takeaways';
export type LegalKind = 'terms' | 'privacy';
export type LegalRef = { kind: LegalKind; version: number };
export type LegalDoc = LegalRef & { body: string; createdAt: string };
export type AdminLegalDoc = LegalDoc & { id: string; createdBy: string; acceptances: number };
export type Me = { id: string; email: string; name: string | null; balance: number; preferences: Preferences; role: 'user' | 'admin'; legal: { pending: LegalRef[] } };
export type TokenParam = 'max_tokens' | 'max_completion_tokens';
export type AdminProviderKey = { status: 'ok' | 'missing' | 'unknown'; source: 'LLM_KEY' | 'LLM_PROVIDERS' | 'none' | null; checkedAt: string | null };
export type AdminProvider = { id: string; baseUrl: string; tokenParam: TokenParam; maxConcurrency: number | null; keyEnv: string; key: AdminProviderKey };
export type AdminProviderInput = { baseUrl: string; tokenParam: TokenParam; maxConcurrency: number | null };
export type AdminModel = {
  id: string; label: string; provider: string; model: string; multiplier: number; temperature: number | null;
  priceIn: number | null; priceOut: number | null; adminOnly: boolean; enabled: boolean; position: number;
};
export type LaneModel = { modelId: string; label: string; provider: string; model: string };
export type PhaseUsage = { calls: number; inputTokens: number; outputTokens: number; durationMs: number; failedCalls: number };
export type Scores = { accuracy: number; coverage: number; concision: number; structure: number };
export type Evaluation = {
  judge: string; overall: number | null; scores: Scores | null; error: string | null;
  chapters: { index: number; title: string; scores: Scores | null; issues: string[] }[];
};
export type Lane = {
  index: number; harness: boolean; jobId: string; draft: LaneModel; verify: LaneModel | null;
  status: JobStatus; progress: number; phase: string; error: string | null;
  durationMs: number | null; createdAt: string; finishedAt: string | null; warnings: string[];
  usage: { draft: PhaseUsage; verify: PhaseUsage; judge: PhaseUsage }; costUsd: number | null;
  judgeCostUsd: number | null; evaluation: Evaluation | null;
};
export type BenchmarkSummary = {
  id: string; name: string | null; createdAt: string; document: { id: string; filename: string };
  lanes: number; done: number; failed: number; running: number;
};
export type BenchmarkDetail = {
  id: string; name: string | null; createdAt: string; options: Record<string, unknown>;
  document: { id: string; filename: string; words: number | null; pages: number | null }; lanes: Lane[];
};
export type LaneSpec = { draft: string; verify: string | null; harness?: boolean };
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

export const formatPrice = fmt.price;

// Builds "?a=1&b=2", skipping empty values.

export const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const LANGUAGES = (['auto', 'en', 'it', 'nl', 'fr', 'de', 'es'] as const).map((v) => [v, t(`languages.${v}`)] as const);
export const QUICK_LENGTHS = [[33, '1/3'], [20, '1/5'], [10, '1/10']] as const;
export const EXTRAS = (['glossary', 'questions', 'takeaways'] as const).map((v) => [v, t(`extras.${v}`)] as const);

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
export const PRESETS = (['studio', 'schematico', 'abstract'] as const).map((v) => [v, t(`presets.${v}`)] as const);

// Style select options: optional leading entries, the 3 presets, then the user's custom methods.
export const styleOptions = (methods: Method[] = [], first: readonly (readonly [string, string])[] = []) =>
  [...first, ...PRESETS, ...methods.map((m) => [`custom:${m.id}`, m.name] as const)] as readonly (readonly [string, string])[];

// Label of a job's style; old jobs only have options.preset.
export function methodLabel(options: Record<string, unknown>, methods: Method[] = []) {
  const id = String(options.method ?? options.preset ?? '');
  const preset = PRESETS.find(([v]) => v === id);
  if (preset) return preset[1];
  if (typeof options.methodName === 'string') return options.methodName;
  return methods.find((m) => `custom:${m.id}` === id)?.name ?? t('api.customDeleted');
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
  if (d.status === 'uploaded') return uploadFailed(d) ? t('api.uploadFailed') : t('api.analyzing');
  if (d.status === 'rejected') return t('api.rejected', { reason: d.rejectReason ?? '' });
  const job = d.jobs[0];
  if (!job) return t('api.pagesCredits', { pages: d.pages ?? '', credits: d.credits ?? '' });
  if (job.status === 'done') return t('common.done');
  if (job.status === 'failed') return t('common.failed');
  return `${job.progress}%`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) {
    super(message);
  }
}

export type EmailTemplate = {
  key: string; placeholders: { name: string; required: boolean }[]; subject: string; body: string; isDefault: boolean;
  updatedAt: string | null; defaultSubject: string; defaultBody: string;
};

export const LEGAL_REQUIRED = 'legal-required';

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
    // The user must accept new legal texts first: RequireUser listens and refreshes `me`, which redirects to /accept.
    if (res.status === 403 && body?.code === 'legal_acceptance_required') window.dispatchEvent(new Event(LEGAL_REQUIRED));
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });

export const useLegal = (kind: LegalKind) =>
  useQuery({ queryKey: ['legal', kind], queryFn: () => api<LegalDoc>(`/legal/${kind}`), retry: false });

export function useAcceptLegal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documents: LegalRef[]) => api('/me/legal/accept', { method: 'POST', body: JSON.stringify({ documents }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (confirm: string) => api('/me', { method: 'DELETE', body: JSON.stringify({ confirm }) }),
    onSuccess: () => qc.clear(),
  });
}

export const useAdminLegal = (kind: LegalKind) =>
  useQuery({ queryKey: ['admin', 'legal', kind], queryFn: () => api<AdminLegalDoc[]>(`/admin/legal/${kind}`) });

export function usePublishLegal(kind: LegalKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api<AdminLegalDoc>(`/admin/legal/${kind}`, { method: 'POST', body: JSON.stringify({ body }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'legal', kind] });
      qc.invalidateQueries({ queryKey: ['legal', kind] });
    },
  });
}

export const useAdminEmailTemplates = () => useQuery({ queryKey: ['admin', 'email-templates'], queryFn: () => api<EmailTemplate[]>('/admin/email-templates') });

const emailBody = (subject: string, body: string) => JSON.stringify({ subject, body });

export function useSaveEmailTemplate(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { subject: string; body: string }) => api<EmailTemplate>(`/admin/email-templates/${key}`, { method: 'PUT', body: emailBody(v.subject, v.body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'email-templates'] }),
  });
}

export const usePreviewEmailTemplate = (key: string) =>
  useMutation({ mutationFn: (v: { subject: string; body: string }) => api<{ subject: string; body: string }>(`/admin/email-templates/${key}/preview`, { method: 'POST', body: emailBody(v.subject, v.body) }) });

export function useResetEmailTemplate(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api(`/admin/email-templates/${key}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'email-templates'] }),
  });
}

export const useMethods = () => useQuery({ queryKey: ['methods'], queryFn: () => api<Method[]>('/methods') });

export const useModels = () => useQuery({ queryKey: ['models'], queryFn: () => api<Model[]>('/models') });

export const useAdminModels = () =>
  useQuery({ queryKey: ['admin', 'models'], queryFn: () => api<{ providers: AdminProvider[]; models: AdminModel[] }>('/admin/models') });

export type AdminUser = {
  id: string; email: string; name: string | null; role: 'user' | 'admin'; createdAt: string; deletedAt: string | null;
  balance: number; documents: number; jobs: number; lastActiveAt: string | null;
};
export type AdminLedgerEntry = { id: string; type: string; amount: number; createdAt: string; jobId: string | null; note: string | null; adminEmail: string | null };
export type AdminUserDetail = AdminUser & { preferences: Preferences; ledger: AdminLedgerEntry[] };
export type AdminDoc = {
  id: string; filename: string; status: Doc['status']; sizeBytes: number; pages: number | null; words: number | null; usedOcr: boolean;
  createdAt: string; fileDeletedAt: string | null; rejectReason: string | null; user: { id: string; email: string }; jobs: number;
};
export type AdminJob = {
  id: string; kind: 'analyze' | 'summarize'; status: JobStatus; phase: string; progress: number; credits: number; attempts: number;
  modelId: string | null; model: string | null; createdAt: string; finishedAt: string | null; durationMs: number | null;
  error: string | null; benchmarkId: string | null; user: { id: string; email: string }; document: { id: string; filename: string };
};
export type AdminJobDetail = AdminJob & {
  options: Record<string, unknown>; warnings: string[]; inputTokens: number | null; outputTokens: number | null;
  usage: unknown; costUsd: number | null; ledger: { id: string; type: string; amount: number; createdAt: string; note?: string | null }[];
};
export type AdminDocDetail = Omit<AdminDoc, 'jobs'> & { chapters: Chapter[] | null; jobs: AdminJob[] };
export type StatsDay = {
  day: string; signups: number; documents: number; jobsDone: number; jobsFailed: number;
  creditsSpent: number; creditsPurchased: number; inputTokens: number; outputTokens: number;
};
export type AdminStats = {
  totals: {
    users: number; activeUsers30d: number; documents: number; jobs: Record<JobStatus, number>;
    creditsPurchased: number; creditsGranted: number; creditsRevoked: number; creditsSpent: number; creditsOutstanding: number;
    llm: { calls: number; failedCalls: number; inputTokens: number; outputTokens: number; costUsd: number | null };
  };
  series: StatsDay[];
  models: { modelId: string; provider: string; calls: number; failedCalls: number; inputTokens: number; outputTokens: number; avgDurationMs: number | null; costUsd: number | null }[];
};
export type AdminModelInput = Partial<Omit<AdminModel, 'id'>>;

export const useAdminStats = (days: number) =>
  useQuery({ queryKey: ['admin', 'stats', days], queryFn: () => api<AdminStats>(`/admin/stats${qs({ days })}`) });
export const useAdminUsers = (q: string, page: number) =>
  useQuery({ queryKey: ['admin', 'users', 'list', q, page], queryFn: () => api<Page<AdminUser>>(`/admin/users${qs({ q, page })}`) });
export const useAdminUser = (id?: string) =>
  useQuery({ queryKey: ['admin', 'users', id], queryFn: () => api<AdminUserDetail>(`/admin/users/${id}`), enabled: !!id });
export const useAdminDocs = (f: { q: string; status: string; userId: string; page: number }) =>
  useQuery({ queryKey: ['admin', 'documents', 'list', f], queryFn: () => api<Page<AdminDoc>>(`/admin/documents${qs(f)}`) });
export const useAdminDoc = (id?: string) =>
  useQuery({ queryKey: ['admin', 'documents', id], queryFn: () => api<AdminDocDetail>(`/admin/documents/${id}`), enabled: !!id });
export const useAdminJobs = (f: { status: string; kind: string; lab: string; userId: string; documentId: string; page: number }) =>
  useQuery({ queryKey: ['admin', 'jobs', 'list', f], queryFn: () => api<Page<AdminJob>>(`/admin/jobs${qs(f)}`) });
export const useAdminJob = (id?: string) =>
  useQuery({ queryKey: ['admin', 'jobs', id], queryFn: () => api<AdminJobDetail>(`/admin/jobs/${id}`), enabled: !!id });

// Opens a presigned download URL returned by the admin endpoints (same approach as JobPage).
export async function openAdminDownload(path: string) {
  const { url } = await api<{ url: string }>(path);
  window.location.href = url;
}

export function useAdminCredits(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { amount: number; note: string }) =>
      api<{ balance: number }>(`/admin/users/${userId}/credits`, { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
}

const invalidateModels = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ['admin', 'models'] });
  qc.invalidateQueries({ queryKey: ['models'] });
  qc.invalidateQueries({ queryKey: ['me'] });
};

export function useSaveAdminModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, create, ...body }: AdminModelInput & { id: string; create?: boolean }) =>
      create
        ? api<AdminModel>('/admin/models', { method: 'POST', body: JSON.stringify({ id, ...body }) })
        : api<AdminModel>(`/admin/models/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => invalidateModels(qc),
  });
}

export function useReorderAdminModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api('/admin/models/order', { method: 'POST', body: JSON.stringify({ ids }) }),
    onSuccess: () => invalidateModels(qc),
  });
}

// Poll every 5 s while the worker has not reported a key status (any row unknown) or `fast` (just after a create).
export const useAdminProviders = (fast = false) =>
  useQuery({
    queryKey: ['admin', 'providers'], queryFn: () => api<AdminProvider[]>('/admin/providers'),
    refetchInterval: (q) => (fast || q.state.data?.some((p) => p.baseUrl !== 'fake' && p.key.status === 'unknown') ? 5000 : false),
  });

// Models embed the providers, so both admin queries are refreshed.
const invalidateProviders = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ['admin', 'providers'] });
  qc.invalidateQueries({ queryKey: ['admin', 'models'] });
};

export function useSaveAdminProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, create, ...body }: AdminProviderInput & { id: string; create?: boolean }) =>
      create
        ? api<AdminProvider>('/admin/providers', { method: 'POST', body: JSON.stringify({ id, ...body }) })
        : api<AdminProvider>(`/admin/providers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => invalidateProviders(qc),
  });
}

export function useDeleteAdminProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/admin/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateProviders(qc),
  });
}

export const laneActive = (l: Lane) => l.status === 'queued' || l.status === 'running';

export const priceHint = (m: AdminModel) =>
  m.priceIn === null && m.priceOut === null ? t('adminLab.noPrice') : t('adminLab.priceHint', { in: m.priceIn ?? '?', out: m.priceOut ?? '?' });

export const usePacks = () => useQuery({ queryKey: ['packs'], queryFn: () => api<BillingPacks>('/billing/packs') });

export async function uploadFile(file: File) {
  const { document, uploadUrl } = await api<{ document: Doc; uploadUrl: string }>('/documents', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, sizeBytes: file.size }),
  });
  const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/pdf' } });
  if (!put.ok) throw new Error(t('api.uploadFailedStatus', { status: put.status }));
  await api(`/documents/${document.id}/uploaded`, { method: 'POST' });
}
