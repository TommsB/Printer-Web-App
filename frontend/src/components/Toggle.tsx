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

import RubberSegment from './RubberSegment'

/**
 * Segmented choice (e.g. Krāsains / Melnbalts) — every switch and filter in the app. A React Bits RubberSegment:
 * the chosen pill stretches over to the new option and snaps in, and can be dragged. Its size and colours come
 * from the .seg styles where it sits (index.css). `className` replaces the default "seg seg--form" (form
 * fields); page switches pass plain "seg".
 */
export function Segmented<T extends string>({ value, options, onChange, label, className = 'seg seg--form', disabled = false }: {
  value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void; label: string; className?: string
  disabled?: boolean // greyed out and not clickable (kept in place, e.g. Toneri / Drumi while Izmaksas is shown)
}) {
  return (
    <RubberSegment items={options} value={value} onChange={(v) => onChange(v as T)} equalSlots={false} aria-label={label} className={className} disabled={disabled} />
  )
}
