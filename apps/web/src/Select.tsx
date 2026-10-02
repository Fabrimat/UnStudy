export default function Select<T extends string | number>(props: { label: string; value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[] }) {
  return (
    <label className="block">
      {props.label}
      <select
        className="mt-1 w-full rounded-xl border border-edge bg-white px-3 py-2.5"
        value={props.value}
        onChange={(e) => props.onChange((typeof props.value === 'number' ? Number(e.target.value) : e.target.value) as T)}
      >
        {props.options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </label>
  );
}
