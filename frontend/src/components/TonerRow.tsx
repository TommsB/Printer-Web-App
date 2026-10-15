import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { UNASSIGNED, type StoreLocation } from '../api'
import { Icon } from '../icons'
import { CorrectDialog, LocationDialog, OrderDialog, UseDialog, WarrantyDialog, type TonerRowData } from './TonerDialogs'
import { DotTile } from './ColorDot'

export type { TonerRowData }

interface Props {
  printerId: number
  printerName: string
  toner: TonerRowData
  allLocations: StoreLocation[]
  emptiesDefault?: number | null // the printer's default place for empty cartridges ("Izlietots" pre-selects it)
  onChange: () => void
  /** Krājumi by storage place: the place this row is shown under. The row then names the printer instead of the
   *  place, shows how many are kept here (not stock/norm), and its dialogs start from this place. */
  place?: number
  /** The printer's main storage place: "Lokācija" moves cartridges there by default, from wherever else they are. */
  mainLocation?: number | null
}

/** Which action dialog is open; each one is its own component (see TonerDialogs.tsx). */
type OpenDialog = 'use' | 'order' | 'location' | 'correct' | 'warranty' | null

/** Toners are the normal case and get no tag; a drum or another consumable is marked, since the colour dot alone can't tell. */

/** Latvian: 1, 21, 31… lokācija (but 11 lokācijas); everything else lokācijas. */
const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'lokācija' : 'lokācijas')

/**
 * One cartridge of one printer, on a single line: colour · code · where it is · qty/norm · ⋮.
 * The ⋮ menu opens the deliberate actions (each confirms in a dialog and is logged).
 */
export function TonerRow({ printerId, printerName, toner, allLocations, emptiesDefault, onChange, place, mainLocation }: Props) {
  const [dialog, setDialog] = useState<OpenDialog>(null)
  // Seen from a place: that place first, so "Izlietots" and "Lokācija" start from it.
  // Otherwise the places away from the main one come first, so a move starts from where there is something to move.
  const t = place !== undefined
    ? { ...toner, locations: [...toner.locations].sort((a, b) => (a.location_id === place ? -1 : b.location_id === place ? 1 : 0)) }
    : mainLocation ? { ...toner, locations: [...toner.locations].sort((a, b) => (a.location_id === mainLocation ? 1 : 0) - (b.location_id === mainLocation ? 1 : 0)) }
    : toner
  const places = t.locations
  const here = place === undefined ? null : places.find((l) => l.location_id === place)?.qty ?? 0
  const common = { printerId, printerName, toner: t, onDone: onChange, onClose: () => setDialog(null) }

  // Location label on the row: the short name ("Saīsinājums") of the one location, or "N lokācijas".
  // Tapping it opens the Lokācija dialog with the full breakdown.
  const label = place !== undefined ? printerName
    : places.length === 0 ? null
    : places.length === 1 ? (places[0].short || places[0].name)
    : `${places.length} ${plural(places.length)}`

  return (
    <div className="trow">
      <div className="t">
        <span className="cd">
          <DotTile color={t.color} kind={t.kind} />
          {/* No "Cits" tag here: a long name already fills the row; the full name is in the tooltip when cut short. */}
          <span className="code" title={t.code}>{t.code}</span>
          {label && (
            <button className={places.length === 1 && places[0].name === UNASSIGNED ? 'loc unassigned' : 'loc'}
              onClick={() => setDialog('location')} title={places.map((p) => `${p.name}: ${p.qty}`).join('\n')}>{label}</button>
          )}
          <OrderedMark toner={t} />
        </span>
        <span className="sa">
          {here === null
            ? <span className={t.qty < t.optimal_qty ? 'stp ro hot' : 'stp ro'} title={`Krājumā ${t.qty}, norma ${t.optimal_qty}`}>
                <span className="q">{t.qty}<small>/{t.optimal_qty}</small></span>
              </span>
            : <span className={t.qty < t.optimal_qty ? 'stp ro hot' : 'stp ro'} title={`Šeit ${here}; kopā ${t.qty}, norma ${t.optimal_qty}${t.qty < t.optimal_qty ? ' (zem normas)' : ''}`}>
                <span className="q">{here}<small> gab.</small></span>
              </span>}
          <ActionMenu code={t.code} items={[
            { label: 'Izlietots', icon: Icon.used(), disabled: t.qty <= 0, run: () => setDialog('use') },
            { label: 'Pievienot grozam', icon: Icon.cartPlus(), run: () => setDialog('order') },
            { label: 'Lokācija', icon: Icon.pin(), run: () => setDialog('location'), divider: true },
            { label: 'Labot daudzumu', icon: Icon.pencil(18), run: () => setDialog('correct') },
            { label: 'Atzīmēt kā bojātu', icon: Icon.warn(), run: () => setDialog('warranty'), divider: true },
          ]} />
        </span>
      </div>

      {dialog === 'use' && <UseDialog {...common} locations={allLocations} emptiesDefault={emptiesDefault} />}
      {dialog === 'order' && <OrderDialog {...common} />}
      {dialog === 'location' && <LocationDialog {...common} locations={allLocations} mainLocation={mainLocation} />}
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

interface MenuItem { label: string; run: () => void; disabled?: boolean; divider?: boolean; checked?: boolean; note?: string; icon?: ReactNode }
/** A menu opened from another button than ⋮ (e.g. the view switch in Krājumi): its look, icon and name. */
interface MenuButton { className: string; icon: ReactNode; label: string; title?: string }

/** ⋮ button + popover menu, rendered in a portal (fixed position) so panels can't clip it.
 *  Also used for the order rows in Krājumi → Pasūtīts. `code` names the row for screen readers. */
export function ActionMenu({ code, items, button, title }: { code: string; items: MenuItem[]; button?: MenuButton; title?: string }) {
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
      <button ref={btn} className={`${button?.className ?? 'kebab'}${open ? ' on' : ''}`} onClick={toggle} title={button?.title}
        aria-haspopup="menu" aria-expanded={open} aria-label={button?.label ?? `Darbības: ${code}`}>{button?.icon ?? Icon.more(18)}</button>
      {open && createPortal(
        <span className={items.some((it) => it.checked !== undefined) ? 'menu menu--pick' : 'menu'} role="menu" aria-label={button?.label ?? `Darbības: ${code}`} ref={menu} style={pos} onKeyDown={onMenuKey}>
          {title && <span className="menu__title" aria-hidden="true">{title}</span>}
          {items.map((it) => (
            // Focus goes back to ⋮ first, so the dialog that opens returns focus there when it closes.
            <button key={it.label} role={it.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={it.checked} tabIndex={-1}
              className={[it.divider && 'sep', it.checked && 'on'].filter(Boolean).join(' ') || undefined} disabled={it.disabled}
              onClick={() => { closeToButton(); it.run() }}>
              {it.icon && <span className="menu__ic">{it.icon}</span>}
              <span className="menu__lab">{it.label}{it.note && <small>{it.note}</small>}</span>{it.checked && Icon.check(16)}
            </button>
          ))}
        </span>,
        document.body,
      )}
    </>
  )
}
