import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { UNASSIGNED, type StoreLocation } from '../api'
import { Icon } from '../icons'
import { CorrectDialog, LocationDialog, OrderDialog, UseDialog, WarrantyDialog, type TonerRowData } from './TonerDialogs'

export type { TonerRowData }

interface Props {
  printerId: number
  printerName: string
  toner: TonerRowData
  allLocations: StoreLocation[]
  onChange: () => void
}

/** Which action dialog is open; each one is its own component (see TonerDialogs.tsx). */
type OpenDialog = 'use' | 'order' | 'location' | 'correct' | 'warranty' | null

/** Latvian: 1, 21, 31… lokācija (but 11 lokācijas); everything else lokācijas. */
const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'lokācija' : 'lokācijas')

/**
 * One cartridge of one printer, on a single line: colour · code · where it is · qty/norm · ⋮.
 * The ⋮ menu opens the deliberate actions (each confirms in a dialog and is logged).
 */
export function TonerRow({ printerId, printerName, toner: t, allLocations, onChange }: Props) {
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const places = t.locations
  const common = { printerId, printerName, toner: t, onDone: onChange, onClose: () => setDialog(null) }

  // Location label on the row: the short name ("Saīsinājums") of the one location, or "N lokācijas".
  // Tapping it opens the Lokācija dialog with the full breakdown.
  const label = places.length === 0 ? null
    : places.length === 1 ? (places[0].short || places[0].name)
    : `${places.length} ${plural(places.length)}`

  return (
    <div className="trow">
      <div className="t">
        <span className="cd">
          <span className="dot"><i className={t.color ? t.color.toLowerCase() : 'g'} /></span>
          <span className="code">{t.code}</span>
          {label && (
            <button className={places.length === 1 && places[0].name === UNASSIGNED ? 'loc unassigned' : 'loc'}
              onClick={() => setDialog('location')} title={places.map((p) => `${p.name}: ${p.qty}`).join('\n')}>{label}</button>
          )}
          <OrderedMark toner={t} />
        </span>
        <span className="sa">
          <span className={t.qty < t.optimal_qty ? 'stp ro hot' : 'stp ro'} title={`Krājumā ${t.qty}, norma ${t.optimal_qty}`}>
            <span className="q">{t.qty}<small>/{t.optimal_qty}</small></span>
          </span>
          <ActionMenu code={t.code} items={[
            { label: 'Izlietots', disabled: t.qty <= 0, run: () => setDialog('use') },
            { label: 'Pievienot grozam', run: () => setDialog('order') },
            { label: 'Lokācija', run: () => setDialog('location'), divider: true },
            { label: 'Labot daudzumu', run: () => setDialog('correct') },
            { label: 'Atzīmēt kā bojātu', run: () => setDialog('warranty'), divider: true },
          ]} />
        </span>
      </div>

      {dialog === 'use' && <UseDialog {...common} />}
      {dialog === 'order' && <OrderDialog {...common} />}
      {dialog === 'location' && <LocationDialog {...common} locations={allLocations} />}
      {dialog === 'correct' && <CorrectDialog {...common} locations={allLocations} />}
      {dialog === 'warranty' && <WarrantyDialog {...common} />}
    </div>
  )
}

/**
 * Compact "on order" marker: a cart and how many are ordered. Green = the order covers what's missing to
 * reach the norm; amber = still short even when it arrives. The full sentence is in the tooltip / for screen readers.
 */
function OrderedMark({ toner: t }: { toner: TonerRowData }) {
  if (t.ordered <= 0) return null
  const stillMissing = t.optimal_qty - t.qty - (t.ordered - (t.ordered_extra ?? 0)) // extras are on top of the norm
  const text = stillMissing > 0
    ? `Pasūtīts ×${t.ordered} — līdz normai vēl trūks ${stillMissing}`
    : `Pasūtīts ×${t.ordered} — trūkstošais daudzums ir pasūtīts`
  return (
    <span className={stillMissing > 0 ? 'ordered-mark part' : 'ordered-mark'} role="img" aria-label={text} title={text}>
      {Icon.cart(14)}{t.ordered}
    </span>
  )
}

interface MenuItem { label: string; run: () => void; disabled?: boolean; divider?: boolean }

/** ⋮ button + popover menu, rendered in a portal (fixed position) so panels can't clip it.
 *  Also used for the order rows in Krājumi → Pasūtīts. `code` names the row for screen readers. */
export function ActionMenu({ code, items }: { code: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<React.CSSProperties>({})
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLSpanElement>(null)

  const toggle = () => {
    if (open) return setOpen(false)
    const r = btn.current!.getBoundingClientRect()
    const below = window.innerHeight - r.bottom > 60 + items.length * 44 // room for the menu below, else open upwards
    setPos({ right: window.innerWidth - r.right, ...(below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }) })
    setOpen(true)
  }

  // Keyboard: focus goes into the menu on open; ↑/↓/Home/End move between items; Esc/Tab close and return to ⋮.
  const enabledItems = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  useEffect(() => { if (open) enabledItems()[0]?.focus() }, [open])
  const closeToButton = () => { setOpen(false); btn.current?.focus() }
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = enabledItems()
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus() }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(list.length - 1)
    else if (e.key === 'Tab') { e.preventDefault(); closeToButton() }
  }

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onDown = (e: PointerEvent) => {
      const el = e.target as Node
      if (!menu.current?.contains(el) && !btn.current?.contains(el)) close()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus() } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', close, { capture: true, passive: true }) // passive: never delays scrolling
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, { capture: true })
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <>
      <button ref={btn} className={open ? 'kebab on' : 'kebab'} onClick={toggle}
        aria-haspopup="menu" aria-expanded={open} aria-label={`Darbības: ${code}`}>{Icon.more(18)}</button>
      {open && createPortal(
        <span className="menu" role="menu" aria-label={`Darbības: ${code}`} ref={menu} style={pos} onKeyDown={onMenuKey}>
          {items.map((it) => (
            // Focus goes back to ⋮ first, so the dialog that opens returns focus there when it closes.
            <button key={it.label} role="menuitem" tabIndex={-1} className={it.divider ? 'sep' : undefined} disabled={it.disabled}
              onClick={() => { closeToButton(); it.run() }}>{it.label}</button>
          ))}
        </span>,
        document.body,
      )}
    </>
  )
}
