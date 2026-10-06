import { useRef, useState } from 'react'
import { api, UNASSIGNED, type Order, type StockLoc, type StoreLocation } from '../api'
import { invalidate, useApiData } from '../cache'
import { prepareFiles } from '../files'
import { PendingFiles } from './DefectFiles'
import { ConfirmDialog, DestructiveDialog, InfoDialog } from './Dialog'
import { Stepper } from './Stepper'

/**
 * The four actions from a toner row's ⋮ menu. Each is its own component that owns its form state,
 * so nothing (amount, chosen location…) can leak from one dialog into another.
 */

export interface TonerRowData {
  id: number; code: string; color: string; qty: number; optimal_qty: number; ordered: number; locations: StockLoc[]
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

/** Izlietots: take one cartridge out of the reserve (asks which location when there are several). */
export function UseDialog({ printerId, printerName, toner: t, onDone, onClose }: Common) {
  const places = t.locations
  const [fromId, setFromId] = useState(places[0]?.location_id ?? 0)
  return (
    <DestructiveDialog title="Atzīmēt kā izlietotu" confirmLabel="Jā, izlietots" disabled={!fromId} onClose={onClose}
      onConfirm={async () => { await api.useStock(printerId, t.id, fromId, 1); onDone() }}>
      <p className="dlg-text">Noņemt <b>1 gab. {t.code}</b> no krājuma?<br /><span className="muted">{printerName} · kopā {t.qty} → {t.qty - 1}</span></p>
      {places.length > 1
        ? <label>No kuras vietas
            <select value={fromId} onChange={(e) => setFromId(+e.target.value)}>
              {places.map((p) => <option key={p.location_id} value={p.location_id}>{p.name} ({p.qty})</option>)}
            </select>
          </label>
        : places[0] && <p className="dlg-text muted">No: {places[0].name}</p>}
    </DestructiveDialog>
  )
}

/** Pasūtīt: add an order; the reserve only grows when the order is marked received. */
export function OrderDialog({ printerId, printerName, toner: t, onDone, onClose }: Common) {
  const [qtyText, setQtyText] = useState(String(Math.max(1, t.optimal_qty - t.qty - t.ordered)))
  const [note, setNote] = useState('')
  return (
    <ConfirmDialog title={`Pasūtīt ${t.code}`} confirmLabel="Pievienot pasūtījumam" disabled={!isInt(qtyText, 1, 1000)} onClose={onClose}
      onConfirm={async () => { await api.createOrders([{ printer_id: printerId, toner_id: t.id, qty: +qtyText }], note); onDone() }}>
      <p className="dlg-text"><i className={`cdot ${t.color ? t.color.toLowerCase() : 'g'}`} /> <b>{t.code}</b> · {printerName}</p>
      <p className="dlg-text muted">Krājums pieaugs tikai tad, kad pasūtījums tiks atzīmēts kā saņemts.</p>
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
export function WarrantyForm({ code, color, printerName, initialPct, children, onCreate, onDone, onClose }: {
  code: string; color: string; printerName: string
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
      <p className="dlg-text"><i className={`cdot ${color ? color.toLowerCase() : 'g'}`} /> <b>{code}</b> · {printerName}</p>
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
    <WarrantyForm code={t.code} color={t.color} printerName={printerName} onClose={onClose}
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
export function LocationDialog(props: Common & { locations: StoreLocation[] }) {
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

function MoveForm({ printerId, toner: t, onDone, onClose, title, active }: Common & { title: string; active: StoreLocation[] }) {
  const places = t.locations
  const [fromId, setFromId] = useState(places[0]?.location_id ?? 0)
  const [toId, setToId] = useState(active.find((l) => l.id !== (places[0]?.location_id ?? 0))?.id ?? 0)
  const [qtyText, setQtyText] = useState('1')

  const from = places.find((p) => p.location_id === fromId)
  const fromQty = from?.qty ?? 0
  const toQty = places.find((p) => p.location_id === toId)?.qty ?? 0
  const toName = active.find((l) => l.id === toId)?.name ?? ''
  const valid = fromId > 0 && toId > 0 && fromId !== toId && isInt(qtyText, 1, fromQty)

  return (
    <ConfirmDialog title={title} confirmLabel="Pārvietot" disabled={!valid} onClose={onClose}
      onConfirm={async () => { await api.moveStock(printerId, t.id, fromId, toId, +qtyText); onDone() }}>
      <WhereList places={places} />
      <div className="lab" style={{ margin: '6px 0 0' }}>Pārvietot</div>
      <label>No
        <select value={fromId} onChange={(e) => setFromId(+e.target.value)}>
          {places.map((p) => <option key={p.location_id} value={p.location_id}>{p.name} ({p.qty})</option>)}
        </select>
      </label>
      <label>Uz
        <select value={toId} onChange={(e) => setToId(+e.target.value)}>
          {active.filter((l) => l.id !== fromId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      <div className="field"><span>Skaits</span><Stepper label="Skaits" value={qtyText} onChange={setQtyText} min={1} max={Math.max(1, fromQty)} /></div>
      {valid && <p className="dlg-text muted">{from?.name} {fromQty} → {fromQty - +qtyText} · {toName} {toQty} → {toQty + +qtyText}</p>}
    </ConfirmDialog>
  )
}

/** Labot daudzumu: type the actual count per location (stock-take); needs a reason. */
export function CorrectDialog({ printerId, printerName, toner: t, onDone, onClose, locations }: Common & { locations: StoreLocation[] }) {
  const active = locations.filter((l) => l.active)
  const [counts, setCounts] = useState(() =>
    t.locations.map((p) => ({ location_id: p.location_id, name: p.name, current: p.qty, value: String(p.qty) })))
  const [reason, setReason] = useState(REASONS[0])
  const [note, setNote] = useState('')
  const [addLoc, setAddLoc] = useState(0)

  const newTotal = counts.reduce((n, c) => n + (isInt(c.value, 0, 1000) ? +c.value : c.current), 0)
  const valid = counts.every((c) => isInt(c.value, 0, 1000))
  const changed = counts.some((c) => isInt(c.value, 0, 1000) && +c.value !== c.current)
  const addable = active.filter((l) => !counts.some((c) => c.location_id === l.id))

  return (
    <ConfirmDialog title={`Labot daudzumu: ${t.code}`} confirmLabel="Saglabāt" disabled={!valid || !changed} onClose={onClose}
      onConfirm={async () => {
        await api.correctStock(printerId, t.id, Object.fromEntries(counts.map((c) => [c.location_id, +c.value])), reason, note)
        onDone()
      }}>
      <p className="dlg-text muted">Ierakstiet, cik tur ir patiesībā. {printerName}.</p>
      <div className="counts">
        {counts.map((c, i) => (
          <div key={c.location_id} className="counts__row">
            <span>{c.name}</span>
            <Stepper label={c.name} value={c.value} min={0} max={1000}
              onChange={(v) => setCounts(counts.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
          </div>
        ))}
        {addable.length > 0 && (
          <div className="counts__add">
            <select value={addLoc} onChange={(e) => setAddLoc(+e.target.value)} aria-label="Pievienot vietu">
              <option value={0}>+ Pievienot vietu…</option>
              {addable.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <button type="button" className="btn small" disabled={!addLoc} onClick={() => {
              const l = active.find((x) => x.id === addLoc)
              if (l) setCounts([...counts, { location_id: l.id, name: l.name, current: 0, value: '0' }])
              setAddLoc(0)
            }}>Pievienot</button>
          </div>
        )}
      </div>
      <label>Iemesls
        <select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
      </label>
      <label>Piezīme (nav obligāta)<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <p className="dlg-text">Kopā: {t.qty} → <b>{newTotal}</b>{newTotal !== t.qty && <span className="muted"> ({newTotal > t.qty ? '+' : ''}{newTotal - t.qty})</span>}</p>
    </ConfirmDialog>
  )
}
