import { useRef, useState, type ReactNode } from 'react'
import { api, UNASSIGNED, type Order, type StockLoc, type StoreLocation } from '../api'
import { invalidate, useApiData } from '../cache'
import { prepareFiles } from '../files'
import { Icon } from '../icons'
import { missing } from '../lib'
import { offerUndo } from '../undo'
import { PendingFiles } from './DefectFiles'
import { EmptyPlace } from './EmptyPlace'
import { ConfirmDialog, DestructiveDialog, InfoDialog } from './Dialog'
import { Stepper } from './Stepper'
import { CDot } from './ColorDot'

/**
 * The four actions from a toner row's ⋮ menu. Each is its own component that owns its form state,
 * so nothing (amount, chosen location…) can leak from one dialog into another.
 */

export interface TonerRowData {
  id: number; code: string; color: string; qty: number; optimal_qty: number; ordered: number; ordered_extra?: number; locations: StockLoc[]
  kind?: string // 'toner' | 'drum' | 'other': drums and other consumables get a small tag on the row
}

interface Common {
  printerId: number
  printerName: string
  toner: TonerRowData
  onDone: () => void // reload data after a successful change
  onClose: () => void
}

const isInt = (s: string, min: number, max: number) => /^\d+$/.test(s.trim()) && +s >= min && +s <= max
const REASONS = ['Inventarizācija', 'Atrasts', 'Bojāts / norakstīts', 'Cits']

/** Izlietots: take one cartridge out of the reserve (asks which location when there are several), and say
 *  where the empty one goes — the printer's default place for empties is pre-selected. */
export function UseDialog({ printerId, printerName, toner: t, onDone, onClose, locations, emptiesDefault }: Common & {
  locations: StoreLocation[]; emptiesDefault?: number | null
}) {
  const places = t.locations
  const [fromId, setFromId] = useState(places[0]?.location_id ?? 0)
  const leavesEmpty = (t.kind ?? 'toner') !== 'other' // only toners and drums are counted as empties
  const [emptyTo, setEmptyTo] = useState(locations.some((l) => l.id === emptiesDefault && l.active) ? emptiesDefault! : 0)
  return (
    <DestructiveDialog title="Atzīmēt kā izlietotu" confirmLabel="Jā, izlietots" disabled={!fromId} onClose={onClose}
      onConfirm={async () => {
        const done = await api.useStock(printerId, t.id, fromId, 1, leavesEmpty && emptyTo ? emptyTo : null)
        offerUndo(`Izlietots: ${t.code} −1 (${printerName})`, [done.movement_id])
        onDone()
      }}>
      <p className="dlg-text">Noņemt <b>1 gab. {t.code}</b> no krājuma?<br /><span className="muted">{printerName} · kopā {t.qty} → {t.qty - 1}</span></p>
      {places.length > 1
        ? <label>No kuras vietas
            <select value={fromId} onChange={(e) => setFromId(+e.target.value)}>
              {places.map((p) => <option key={p.location_id} value={p.location_id}>{p.name} ({p.qty})</option>)}
            </select>
          </label>
        : places[0] && <p className="dlg-text muted">No: {places[0].name}</p>}
      {leavesEmpty && <EmptyPlace value={emptyTo} onChange={setEmptyTo} locations={locations} drum={t.kind === 'drum'} />}
    </DestructiveDialog>
  )
}

/**
 * Pievienot grozam: put cartridges in the basket (Krājumi → Grozs). Nothing is ordered yet — the order is
 * placed from the basket. What is missing to the norm is in the basket by itself; this quantity comes on top.
 */
export function OrderDialog({ printerId, printerName, toner: t, onDone, onClose }: Common) {
  const [qtyText, setQtyText] = useState('1')
  const [note, setNote] = useState('')
  const short = missing(t)
  return (
    <ConfirmDialog title={`Pievienot grozam: ${t.code}`} confirmLabel="Pievienot grozam" disabled={!isInt(qtyText, 1, 1000)} onClose={onClose}
      onConfirm={async () => {
        await api.addToBasket([{ printer_id: printerId, toner_id: t.id, qty: +qtyText }], note)
        invalidate('basket') // Krājumi's basket must load fresh (this dialog also opens from Statuss)
        onDone()
      }}>
      <p className="dlg-text"><CDot color={t.color} kind={t.kind} /> <b>{t.code}</b> · {printerName}</p>
      <p className="dlg-text muted">
        Toneris parādīsies groza daļā „Pielikts papildus” (Krājumi); pasūtīts tas tiek tur.
        {short > 0 && ` Grozā jau ir ×${short}, kas trūkst līdz normai — šis daudzums būs papildus tam.`}
      </p>
      <div className="field"><span>Daudzums</span><Stepper label="Daudzums" value={qtyText} onChange={setQtyText} min={1} max={1000} /></div>
      <label>Piezīme (nav obligāta)<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
    </ConfirmDialog>
  )
}

export interface WarrantyValues { removed_pct: number | null; defect: string; note: string; held_location_id: number | null }

/**
 * Defekts: put a defective cartridge on the "Defekti" list (Krājumi). Used from a toner's ⋮ menu and from
 * "Jāpārbauda" (which passes the level it was removed at, and its own extra fields as children).
 * Nothing is expected yet and the reserve is not changed. Later, "Nodots garantijā" on that list moves it to
 * "Pasūtīts"; the reserve grows when the replacement is marked "Saņemt" there.
 *
 * `onCreate` makes the record; the chosen photos/files are then attached to it here, and `onDone` refreshes
 * whatever is behind the dialog. If only the files fail, the record stays and confirming again retries just them.
 */
export function WarrantyForm({ code, color, kind, printerName, initialPct, children, onCreate, onDone, onClose }: {
  code: string; color: string; kind?: string; printerName: string
  initialPct?: number | null
  children?: React.ReactNode
  onCreate: (v: WarrantyValues) => Promise<Order>
  onDone: () => Promise<unknown> | void
  onClose: () => void
}) {
  const locations = useApiData<StoreLocation[]>('locations', api.locations, [])
  const [defect, setDefect] = useState('Smērē')
  const [pctText, setPctText] = useState(initialPct == null ? '' : String(initialPct))
  const [note, setNote] = useState('')
  const [heldId, setHeldId] = useState(0)
  const [files, setFiles] = useState<File[]>([])
  const created = useRef<Order | null>(null)
  const pctOk = pctText.trim() === '' || isInt(pctText, 0, 100)
  return (
    <ConfirmDialog title={`Defekts: ${code}`} confirmLabel="Pievienot defektiem" disabled={!defect.trim() || !pctOk}
      onClose={() => { if (created.current) void onDone(); onClose() }}
      onConfirm={async () => {
        created.current ??= await onCreate({
          removed_pct: pctText.trim() === '' ? null : +pctText, defect: defect.trim(), note: note.trim(), held_location_id: heldId || null,
        })
        if (files.length) {
          try { await api.uploadOrderFiles(created.current.id, await prepareFiles(files)) } catch (err) {
            throw new Error(`Defekts ir pievienots, bet failus neizdevās saglabāt (${err instanceof Error ? err.message : 'kļūda'}). Mēģiniet vēlreiz vai pievienojiet tos vēlāk sarakstā „Defekti”.`, { cause: err })
          }
        }
        await onDone()
      }}>
      <p className="dlg-text"><CDot color={color} kind={kind} /> <b>{code}</b> · {printerName}</p>
      <label>Defekts<input value={defect} onChange={(e) => setDefect(e.target.value)} autoComplete="off" placeholder="piem. Smērē…" /></label>
      <label>Izņemts pie (%, ja zināms)
        <input value={pctText} inputMode="numeric" autoComplete="off" onChange={(e) => setPctText(e.target.value)} placeholder="piem. 60…" />
      </label>
      {!pctOk && <span className="error">Procentiem jābūt skaitlim no 0 līdz 100</span>}
      {children}
      <label>Kur atrodas bojātā kasetne (nav obligāti)
        <select value={heldId} onChange={(e) => setHeldId(+e.target.value)}>
          <option value={0}>– nav norādīts –</option>
          {locations.data.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      <PendingFiles files={files} onChange={setFiles} />
      <label>Piezīme (nav obligāta)<input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" /></label>
      <p className="dlg-text muted">Toneris parādīsies sarakstā „Defekti” (Krājumi). Kad to nodosiet garantijā, nospiediet tur „Nodot garantijā” — tad tas pāries uz „Pasūtīts”.</p>
    </ConfirmDialog>
  )
}

/** "Atzīmēt kā bojātu" from a toner row's ⋮ menu (the reserve itself is not touched). */
export function WarrantyDialog({ printerId, printerName, toner: t, onDone, onClose }: Common) {
  return (
    <WarrantyForm code={t.code} color={t.color} kind={t.kind} printerName={printerName} onClose={onClose}
      onCreate={(v) => api.createWarranty({ printer_id: printerId, toner_id: t.id, ...v })}
      onDone={() => {
        invalidate('defects') // Krājumi's Defekti list must load fresh (this dialog also opens from Statuss)
        onDone()
      }} />
  )
}

/** Where the cartridges are now (used in the Lokācija dialog). */
function WhereList({ places }: { places: StockLoc[] }) {
  return (
    <div className="where">
      {places.length === 0 && <p className="dlg-text muted">Krājumā nav neviena.</p>}
      {places.map((p) => (
        <div key={p.location_id} className="where__row">
          <span className={p.name === UNASSIGNED ? 'unassigned' : undefined}>{p.name}</span>
          <b>{p.qty} gab.</b>
        </div>
      ))}
    </div>
  )
}

/**
 * Lokācija: shows where the cartridges are. When moving is possible it's a form with "Pārvietot";
 * otherwise (no stock, or only one location exists) it's information only.
 */
export function LocationDialog(props: Common & { locations: StoreLocation[]; mainLocation?: number | null }) {
  const active = props.locations.filter((l) => l.active)
  const title = `Lokācija: ${props.toner.code}`
  if (props.toner.qty > 0 && active.length >= 2) return <MoveForm {...props} title={title} active={active} />
  return (
    <InfoDialog title={title} onClose={props.onClose}>
      <WhereList places={props.toner.locations} />
      {props.toner.qty > 0 && <p className="dlg-text muted">Lai pārvietotu, pievienojiet vēl kādu vietu sadaļā Pārvaldība → Glabāšanas vietas.</p>}
    </InfoDialog>
  )
}

/** The top of the move and correction windows: what is being done, then the toner — its colour and code. */
function TonerHeading({ action, toner }: { action: string; toner: TonerRowData }) {
  return (
    <span className="theading">
      <span className="theading__k">{action}</span>
      <span className="theading__t"><CDot color={toner.color} kind={toner.kind} big />{toner.code}</span>
    </span>
  )
}

/** − count + (move and correction windows): a sign that can't be used (at the lowest or highest allowed) is greyed out. */
function Count({ value, max, onChange, min = 1, label = 'Skaits' }: { value: number; max: number; onChange: (n: number) => void; min?: number; label?: string }) {
  return (
    <span className="count" role="group" aria-label={label}>
      <button type="button" className="count__b" aria-label="Mazāk" disabled={value <= min} onClick={() => onChange(value - 1)}>{Icon.minus(16)}</button>
      <b aria-live="polite">{value}</b>
      <button type="button" className="count__b" aria-label="Vairāk" disabled={value >= max} onClick={() => onChange(value + 1)}>{Icon.plus(16)}</button>
    </span>
  )
}

/** One column of the move window: a list of places, one picked (a real radio group, drawn as round dots). */
function PlaceList<T>({ name, label, items, picked, onPick, keyOf, text, note }: {
  name: string; label: string; items: T[]; picked: number; onPick: (id: number) => void
  keyOf: (t: T) => number; text: (t: T) => string; note: (t: T) => ReactNode
}) {
  return (
    <fieldset className="mlist">
      <legend className="mlist__lab">{label}</legend>
      {items.map((it) => (
        <label key={keyOf(it)} className={keyOf(it) === picked ? 'mlist__row on' : 'mlist__row'}>
          <input type="radio" name={name} checked={keyOf(it) === picked} onChange={() => onPick(keyOf(it))} />
          <span className="mlist__name">{text(it)}</span>
          <span className="mlist__note">{note(it)}</span>
        </label>
      ))}
    </fieldset>
  )
}

/**
 * Lokācija → move: two lists side by side — from where (the places holding this toner, with their counts) and
 * to where (every other place; the printer's main one first, marked and chosen) — then how many, and what that
 * leaves in each.
 */
function MoveForm({ printerId, printerName, toner: t, onDone, onClose, active, mainLocation }: Common & { title: string; active: StoreLocation[]; mainLocation?: number | null }) {
  const places = t.locations.filter((p) => p.qty > 0)
  const [fromId, setFromId] = useState(places[0]?.location_id ?? 0)
  // "Uz": the printer's main storage place (when the cartridges are elsewhere), else the first other place.
  const startFrom = places[0]?.location_id ?? 0
  const [toId, setToId] = useState(mainLocation && mainLocation !== startFrom && active.some((l) => l.id === mainLocation)
    ? mainLocation : active.find((l) => l.id !== startFrom)?.id ?? 0)
  const [qty, setQty] = useState(1)

  const from = places.find((p) => p.location_id === fromId)
  const fromQty = from?.qty ?? 0
  const n = Math.min(qty, Math.max(1, fromQty)) // never more than the chosen place holds
  const toQty = t.locations.find((p) => p.location_id === toId)?.qty ?? 0
  const toName = active.find((l) => l.id === toId)?.name ?? ''
  const valid = fromId > 0 && toId > 0 && fromId !== toId && n >= 1 && n <= fromQty
  const pickFrom = (id: number) => {
    setFromId(id)
    if (id === toId) setToId(active.find((l) => l.id !== id)?.id ?? 0) // can't move a place onto itself
  }
  const targets = active.filter((l) => l.id !== fromId).sort((a, b) => (b.id === mainLocation ? 1 : 0) - (a.id === mainLocation ? 1 : 0))
  // Shown at once: the printer's main place and the global stores (and the place chosen when the window opened);
  // the rest under "Citas", which opens and closes, and scrolls on its own when it is long.
  const [pinned] = useState(() => new Set(active.filter((l) => l.id === mainLocation || l.is_global || l.id === toId).map((l) => l.id)))
  const [showRest, setShowRest] = useState(false)
  const shortList = targets.filter((l) => pinned.has(l.id))
  const rest = shortList.length ? targets.filter((l) => !pinned.has(l.id)) : []
  const shown = shortList.length ? shortList : targets
  const restPicked = rest.find((l) => l.id === toId)

  return (
    <ConfirmDialog title={`Pārvietot ${t.code}`} heading={<TonerHeading action="Pārvietot" toner={t} />} confirmLabel={valid ? `Pārvietot ${n} gab.` : 'Pārvietot'} disabled={!valid} onClose={onClose}
      onConfirm={async () => { await api.moveStock(printerId, t.id, fromId, toId, n); onDone() }}>
      <p className="move__sub">{printerName} · kopā {t.qty} gab.</p>
      <div className="move__cols">
        <PlaceList name="move-from" label="No" items={places} picked={fromId} onPick={pickFrom}
          keyOf={(p) => p.location_id} text={(p) => p.name} note={(p) => `${p.qty} gab.`} />
        {/* "Uz": the short list; "Citas" adds the rest to it (the window grows), and closes them again. */}
        <fieldset className="mlist">
          <legend className="mlist__lab">Uz</legend>
          {(showRest ? [...shown, ...rest] : shown).map((l) => (
              <label key={l.id} className={l.id === toId ? 'mlist__row on' : 'mlist__row'}>
                <input type="radio" name="move-to" checked={l.id === toId} onChange={() => setToId(l.id)} />
                <span className="mlist__name">{l.name}</span>
                <span className="mlist__note">{l.id === mainLocation ? 'galvenā' : l.is_global ? 'globāla' : ''}</span>
              </label>
          ))}
          {rest.length > 0 && (
            <button type="button" className="mlist__more" aria-expanded={showRest} onClick={() => setShowRest((v) => !v)}>
              <span className={showRest ? 'fold-ic open' : 'fold-ic'}>{Icon.chevron(14)}</span>
              {showRest ? 'Paslēpt citas' : <>Citas ({rest.length}){restPicked && <span className="mlist__picked"> · {restPicked.name}</span>}</>}
            </button>
          )}
        </fieldset>
      </div>
      <div className="move__row">
        <span className="move__lab">Skaits</span>
        <Count value={n} max={fromQty} onChange={setQty} />
      </div>
      {valid && <p className="move__res">{from?.name} <b>{fromQty} → {fromQty - n}</b> · {toName} <b>{toQty} → {toQty + n}</b></p>}
    </ConfirmDialog>
  )
}

/**
 * Labot daudzumu (a stock-take): how many there really are in each place — the places this toner is in, one row
 * each with − count +, a place can be added — then why, an optional note, and the new total.
 */
export function CorrectDialog({ printerId, printerName, toner: t, onDone, onClose, locations }: Common & { locations: StoreLocation[] }) {
  const active = locations.filter((l) => l.active)
  const [counts, setCounts] = useState(() => t.locations.map((p) => ({ location_id: p.location_id, name: p.name, current: p.qty, value: p.qty })))
  const [reason, setReason] = useState(REASONS[0])
  const [note, setNote] = useState('')

  const newTotal = counts.reduce((n, c) => n + c.value, 0)
  const changed = counts.some((c) => c.value !== c.current)
  const addable = active.filter((l) => !counts.some((c) => c.location_id === l.id))
  const add = (id: number) => {
    const l = active.find((x) => x.id === id)
    // Starts at 1: a place is added because something is there (0 would have to be changed every time).
    if (l) setCounts([...counts, { location_id: l.id, name: l.name, current: 0, value: 1 }])
  }

  return (
    <ConfirmDialog title={`Labot daudzumu ${t.code}`} heading={<TonerHeading action="Labot daudzumu" toner={t} />} confirmLabel="Saglabāt" disabled={!changed} onClose={onClose}
      onConfirm={async () => {
        await api.correctStock(printerId, t.id, Object.fromEntries(counts.map((c) => [c.location_id, c.value])), reason, note)
        onDone()
      }}>
      <p className="move__sub">{printerName} · kopā {t.qty} gab. Ierakstiet, cik katrā vietā ir patiesībā.</p>
      <div className="mlist">
        <div className="mlist__lab mlist__head"><span>Vieta</span><span>Skaits</span></div>
        {counts.map((c, i) => (
          <div key={c.location_id} className={c.value !== c.current ? 'mlist__row on' : 'mlist__row'}>
            <span className="mlist__name">{c.name}</span>
            {c.value !== c.current && <span className="mlist__note">bija {c.current}</span>}
            <Count label={c.name} value={c.value} min={0} max={1000} onChange={(v) => setCounts(counts.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
          </div>
        ))}
        {addable.length > 0 && (
          <div className="mlist__row mlist__addrow">
            {/* choosing a place adds it at once */}
            <select className="mlist__add" value={0} onChange={(e) => add(+e.target.value)} aria-label="Pievienot vietu">
              <option value={0}>+ Pievienot vietu…</option>
              {addable.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        )}
      </div>
      <fieldset className="mlist">
        <legend className="mlist__lab">Iemesls</legend>
        {REASONS.map((r) => (
          <label key={r} className={r === reason ? 'mlist__row on' : 'mlist__row'}>
            <input type="radio" name="correct-reason" checked={r === reason} onChange={() => setReason(r)} />
            <span className="mlist__name">{r}</span>
          </label>
        ))}
      </fieldset>
      <label>Piezīme (nav obligāta)<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <p className="move__res">Kopā <b>{t.qty} → {newTotal}</b>{newTotal !== t.qty && <> ({newTotal > t.qty ? '+' : ''}{newTotal - t.qty})</>}</p>
    </ConfirmDialog>
  )
}
