import type { ReactNode } from 'react'
import { Icon } from '../../icons'
import { dayLabel } from '../../lib'
import { useRemembered } from '../../uiMemory'

/** Which days are folded in one list (remembered while moving around the app). Days start open. */
export function useFoldedDays(key: string) {
  const [folded, setFolded] = useRemembered<string[]>(key, [])
  const toggle = (day: string) => setFolded((list) => (list.includes(day) ? list.filter((d) => d !== day) : [...list, day]))
  return { isFolded: (day: string) => folded.includes(day), toggle }
}

/**
 * One day in Vēsture: the (sticky) date heading is a button that folds/unfolds that day's records.
 * `summary` (the day's totals) stays visible when folded; `count` is announced so it's clear what is hidden.
 */
export function DayGroup({ day, summary, count, folded, onToggle, children }: {
  day: string // "YYYY-MM-DD"
  summary: ReactNode
  count: number
  folded: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className={folded ? 'day folded' : 'day'}>
      <button type="button" className="day__head" aria-expanded={!folded} onClick={onToggle}
        title={folded ? `Rādīt ierakstus (${count})` : 'Paslēpt ierakstus'}>
        <span className="day__name">
          <span className={folded ? 'fold-ic' : 'fold-ic open'}>{Icon.chevron(14)}</span>
          {dayLabel(day)}
          {folded && <span className="day__count">{count}</span>}
        </span>
        <span className="day__sum">{summary}</span>
      </button>
      {!folded && children}
    </div>
  )
}
