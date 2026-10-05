/** On/off switch with a label and optional hint line. */
export function Toggle({ checked, onChange, label, hint, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean
}) {
  return (
    <label className={disabled ? 'toggle off' : 'toggle'}>
      <span className="toggle__txt">{label}{hint && <small>{hint}</small>}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle__ui" aria-hidden="true" />
    </label>
  )
}

/** Segmented choice (e.g. Krāsains / Melnbalts). */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void; label: string
}) {
  return (
    <div className="seg seg--form" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  )
}
