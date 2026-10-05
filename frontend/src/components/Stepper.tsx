import { Icon } from '../icons'

interface Props {
  value: string // kept as text so the field can be typed into freely
  onChange: (v: string) => void
  min: number
  max: number
  label?: string // accessible name for the number field
  autoFocus?: boolean
}

/** [▾] [ n ] [▴] — change an amount by tapping, or type it. Buttons stop at min/max. */
export function Stepper({ value, onChange, min, max, label, autoFocus }: Props) {
  const n = /^\d+$/.test(value.trim()) ? +value : NaN
  const step = (d: number) => {
    const base = Number.isNaN(n) ? (d > 0 ? min - 1 : max + 1) : n
    onChange(String(Math.min(max, Math.max(min, base + d))))
  }
  return (
    <span className="stepper">
      <button type="button" className="stepper__btn" onClick={() => step(-1)} disabled={!Number.isNaN(n) && n <= min}
        aria-label="Mazāk">{Icon.down(18)}</button>
      <input type="number" inputMode="numeric" min={min} max={max} step={1} value={value} autoFocus={autoFocus}
        aria-label={label} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="stepper__btn" onClick={() => step(1)} disabled={!Number.isNaN(n) && n >= max}
        aria-label="Vairāk">{Icon.up(18)}</button>
    </span>
  )
}
