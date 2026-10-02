import { busy, Doc, docStatus, uploadFailed } from './api';
import { t } from './i18n';

export function Logo({ size = 32, onDark = false }: { size?: number; onDark?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill={onDark ? '#fff' : '#24173A'} />
      <path d="M10.500 7v10a5.500 5.500 0 0 0 11 0" fill="none" stroke={onDark ? '#24173A' : '#fff'} strokeWidth="3.600" strokeLinecap="round" />
      <circle cx="21.500" cy="8" r="2.400" fill="#C93C20" />
    </svg>
  );
}

const TONES = { done: 'bg-[#E1F0E7] text-[#1B5E3B]', run: 'bg-ink text-white', idle: 'bg-alt text-soft', bad: 'bg-[#F8E1DE] text-[#A3231B]' };

export function Chip({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return <span className={`shrink-0 rounded-full px-3 py-1 text-[13px] font-medium ${TONES[tone]}`}>{children}</span>;
}

export function DocChip({ d }: { d: Doc }) {
  const job = d.jobs[0];
  const tone = d.status === 'rejected' || uploadFailed(d) || job?.status === 'failed' ? 'bad' : job?.status === 'done' ? 'done' : busy(d) ? 'run' : 'idle';
  return <Chip tone={tone}>{d.status === 'analyzed' && !job ? t('documents.ready') : docStatus(d)}</Chip>;
}
