import { useState } from 'react'
import { Icon } from '../icons'

/** A small search icon that expands into a field. Collapses again when emptied (×, Esc, or leaving it empty). */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [open, setOpen] = useState(value !== '')
  const close = () => { onChange(''); setOpen(false) }
  const label = placeholder.replace(/…$/, '')

  if (!open) {
    return (
      <button className="icon-btn" onClick={() => setOpen(true)} aria-label={label} title="Meklēt">{Icon.search(18)}</button>
    )
  }
  return (
    <label className="search">
      <span className="search__ic">{Icon.search(16)}</span>
      {/* autoFocus is fine here: the field only appears after tapping the search icon. */}
      <input type="search" autoFocus value={value} placeholder={placeholder} aria-label={label}
        autoComplete="off" spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => { if (!value) setOpen(false) }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }} />
      <button type="button" className="search__x" onMouseDown={(e) => e.preventDefault()} onClick={close} aria-label="Aizvērt meklēšanu">{Icon.close(16)}</button>
    </label>
  )
}

/** Case-insensitive match of every typed word against any of the given fields. */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const hay = fields.join(' ').toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}
