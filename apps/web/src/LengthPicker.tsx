import { QUICK_LENGTHS } from './api';

export default function LengthPicker({ value, onChange, words }: { value: number; onChange: (v: number) => void; words?: number }) {
  return (
    <div>
      Length: {value}%{words !== undefined && ` (≈ ${Math.round((words * value) / 100)} words)`}
      <div className="mt-1 flex items-center gap-2">
        <input type="range" min={5} max={50} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1" />
        {QUICK_LENGTHS.map(([v, label]) => (
          <button key={v} type="button" onClick={() => onChange(v)} className={`rounded border px-2 py-1 text-sm ${value === v ? 'bg-black text-white' : 'bg-white'}`}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
