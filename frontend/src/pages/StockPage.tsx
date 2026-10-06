import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, fmtTime, type Order, type Printer, type StockRow, type StoreLocation } from '../api'
import { useApiData } from '../cache'
import { DefectDialog, PendingFiles } from '../components/DefectFiles'
import { ConfirmDialog, DestructiveDialog } from '../components/Dialog'
import { prepareFiles } from '../files'
import { fmtNum, missing } from '../lib'
import { ORDER_EMAIL, OrderEmailDialog, WARRANTY_EMAIL, type EmailFlavor, type EmailItem } from '../components/OrderEmailDialog'
import { matches, SearchBox } from '../components/SearchBox'
import { Stepper } from '../components/Stepper'
import { ActionMenu, TonerRow } from '../components/TonerRow'
import { TopBar } from '../components/TopBar'
import { useRemembered } from '../uiMemory'
import { useApp } from '../ctx'
import { Icon } from '../icons'
import { vtName, withViewTransition } from '../viewTransition'

/** One toner in the basket ("Grozs"): which printer/toner, its colour for the dot, and how many — what is
 *  missing to the norm plus what was added by hand (`added`, in the basket entries `plannedIds`). */
interface Need {
  printer_id: number; toner_id: number; code: string; color: string; kind: string; company: string; model: string
  qty: number; added: number; plannedIds: number[]
}

const COLOR_LV: Record<string, string> = { K: 'melns', C: 'ciāns', M: 'purpurs', Y: 'dzeltens' }

/** Toner colour dot (grey when the toner has no colour set); the colour name is read out / shown on hover. */
function Dot({ color }: { color: string }) {
  const name = COLOR_LV[color.toUpperCase()]
  return <i className={`cdot ${color ? color.toLowerCase() : 'g'}`} {...(name && { role: 'img', 'aria-label': name, title: name })} />
}

/** After orders were received: attach the chosen delivery notes, each to its group of orders. The orders stay
 *  received if this fails; the message says so and where the note can be added later. */
async function attachNotes(groups: { ids: number[]; files: File[] }[]) {
  try {
    for (const g of groups) if (g.files.length) await api.uploadDeliveryDocs(g.ids, await prepareFiles(g.files))
  } catch (err) {
    throw new Error(`Saņemts, bet dokumentu neizdevās saglabāt (${err instanceof Error ? err.message : 'kļūda'}). Mēģiniet vēlreiz vai pievienojiet to vēlāk: Vēsture → Pasūtījumi.`, { cause: err })
  }
}

/** "Saņemt" on one open order: how many arrived, where they go, and optionally the delivery note. */
function ReceiveDialog({ order: o, places, onClose, onDone }: {
  order: Order; places: StoreLocation[]; onClose: () => void; onDone: () => Promise<unknown>
}) {
  const [qtyText, setQtyText] = useState(String(o.qty))
  // Default: the printer's usual location, else the first one.
  const [place, setPlace] = useState(places.some((l) => l.id === o.default_location_id) ? o.default_location_id! : (places[0]?.id ?? 0))
  const [note, setNote] = useState<File[]>([])
  const received = useRef(false) // if only the note fails to upload, confirming again must not receive twice
  const qty = Number(qtyText)
  const valid = Number.isInteger(qty) && qty >= 1 && qty <= 1000
  return (
    <ConfirmDialog title={o.warranty ? `Saņemt aizvietotāju: ${o.code}` : `Saņemt ${o.code}`}
      confirmLabel={valid ? `Saņemts (+${qty} krājumā)` : 'Saņemts'} disabled={!valid || !place}
      onClose={() => { if (received.current) void onDone(); onClose() }}
      onConfirm={async () => {
        if (!received.current) { await api.receiveOrder(o.id, qty, place); received.current = true }
        await attachNotes([{ ids: [o.id], files: note }])
        await onDone()
      }}>
      <p className="dlg-text"><Dot color={o.color} /> <b>{o.code}</b> · {o.location}<br />
        <span className="muted">{o.warranty
          ? 'Garantijas aizvietotājs. Tas tiks pievienots rezervei.'
          : `Pasūtīts ×${o.qty}. Ja saņemts mazāk vai vairāk, izmainiet skaitu.`}</span></p>
      <div className="field"><span>Saņemtais daudzums</span>
        <Stepper label="Saņemtais daudzums" value={qtyText} onChange={setQtyText} min={1} max={1000} />
      </div>
      <label>Kur novietot
        <select value={place} onChange={(e) => setPlace(+e.target.value)}>
          {places.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      <PendingFiles files={note} onChange={setNote} label="Dokumenti (nav obligāti)" button="Pievienot dokumentu" />
    </ConfirmDialog>
  )
}

/**
 * "Saņemt visus": every open order at its full ordered quantity, in one step, all into one storage place
 * (pre-selected, changeable; the one used is remembered for next time). A delivery that came short is received one by
 * one with "Saņemts" instead.
 */
function ReceiveAllDialog({ orders, places, onClose, onDone }: {
  orders: Order[]; places: StoreLocation[]; onClose: () => void; onDone: () => Promise<unknown>
}) {
  const [last, setLast] = useRemembered('stock.receiveAllPlace', 0)
  // Pre-selected: the place used last time, else the first one in the list (SP Noliktava — the usual delivery place).
  const [place, setPlace] = useState(places.some((l) => l.id === last) ? last : (places[0]?.id ?? 0))
  const total = orders.reduce((n, o) => n + o.qty, 0)
  // By company: each company's cartridges come with their own delivery note, which can be attached right here.
  const companies = [...new Set(orders.map((o) => o.company))].sort((a, b) => (a === '') === (b === '') ? a.localeCompare(b, 'lv') : a === '' ? 1 : -1)
  const of = (company: string) => orders.filter((o) => o.company === company)
    .sort((a, b) => a.location.localeCompare(b.location, 'lv') || a.code.localeCompare(b.code))
  const [notes, setNotes] = useState<Record<string, File[]>>({})
  const received = useRef(false) // if only a note fails to upload, confirming again must not receive twice

  return (
    <ConfirmDialog title="Saņemt visus pasūtījumus" confirmLabel={`Saņemt ${total} gab.`} disabled={!place}
      onClose={() => { if (received.current) void onDone(); onClose() }}
      onConfirm={async () => {
        if (!received.current) {
          await api.receiveOrders(orders.map((o) => ({ id: o.id, location_id: place })))
          received.current = true
          setLast(place)
        }
        await attachNotes(companies.map((c) => ({ ids: of(c).map((o) => o.id), files: notes[c] ?? [] })))
        await onDone()
      }}>
      {companies.map((c) => (
        <div key={c} className="recv-co">
          <div className="recv-co__head"><b>{c || 'Bez uzņēmuma'}</b></div>
          <ul className="dlg-list toners recv-all">
            {of(c).map((o) => (
              <li key={o.id}><Dot color={o.color} /><b>{o.code}</b> ×{o.qty}{!!o.warranty && <span className="tag-w">Garantija</span>}<span className="recv-all__to">{o.location}</span></li>
            ))}
          </ul>
          <PendingFiles files={notes[c] ?? []} onChange={(f) => setNotes((n) => ({ ...n, [c]: f }))} label="Dokumenti (nav obligāti)" button="Pievienot dokumentu" />
        </div>
      ))}
      <label>Kur novietot
        <select value={place} onChange={(e) => setPlace(+e.target.value)}>
          {places.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      <p className="dlg-text muted">Katrs pasūtījums tiek saņemts pilnā pasūtītajā daudzumā. Ja kāds atnācis nepilns, saņemiet to atsevišķi ar „Saņemts”.</p>
    </ConfirmDialog>
  )
}

type Dlg =
  | { kind: 'receiveAll' }
  | { kind: 'send'; orders: Order[] } // Defekti → "Nodots garantijā" (one, or the whole list)
  | { kind: 'discard'; order: Order } // delete an entry from Defekti
  | { kind: 'defect'; order: Order } // a defect's details, where it is kept, photos/files
  | { kind: 'email'; source: string; flavor: EmailFlavor; items: EmailItem[] }
  | { kind: 'suggest'; loc: string; items: Need[]; extra: boolean } // order one printer's toners from one part of the basket
  | { kind: 'unbasket'; loc: string; item: Need } // take one hand-added toner out of the basket
  | { kind: 'orderAll' } // order the whole basket, both parts
  | { kind: 'receive'; order: Order }
  | { kind: 'cancel'; order: Order }
  | null

export function StockPage() {
  const { company } = useApp()
  // Cached: shows the last copy instantly, refreshes in the background.
  const stock = useApiData<StockRow[]>('stock', api.stock, [])
  const ord = useApiData<Order[]>('orders', () => api.orders('ordered'), [])
  // Defective cartridges not yet handed over for warranty (the "Defekti" list).
  const dfc = useApiData<Order[]>('defects', () => api.orders('defect'), [])
  // Cartridges added to the basket by hand (on top of what is missing to the norm).
  const bsk = useApiData<Order[]>('basket', () => api.orders('planned'), [])
  const locations = useApiData<StoreLocation[]>('locations', api.locations, [])
  const activeLocs = locations.data.filter((l) => l.active)
  const rows = stock.data
  const orders = ord.data
  const [onlyLow, setOnlyLow] = useState(false)
  const [query, setQuery] = useState('')
  const [dlg, setDlg] = useState<Dlg>(null)
  // One card open at a time; remembered when you switch sections and come back.
  const [openId, setOpenId] = useRemembered<number | null>('stock.open', null)

  // A tapped "zems pēdējais toneris" notification arrives as /stock?p=12: open that printer's card, bring it
  // into view and outline it for a moment.
  const [params, setParams] = useSearchParams()
  const wanted = Number(params.get('p')) || null
  const [flash, setFlash] = useState<number | null>(null)
  if (wanted !== null && flash !== wanted) { // adjust state while rendering
    setOpenId(wanted)
    setOnlyLow(false)
    setQuery('')
    setFlash(wanted)
  }
  // One-time: the address goes back to plain /stock, so coming back to Krājumi later doesn't jump again.
  useEffect(() => { if (wanted !== null) setParams({}, { replace: true }) }, [wanted, setParams])
  const flashShown = flash !== null && rows.some((r) => r.printer_id === flash)
  useEffect(() => {
    if (!flashShown) return
    document.getElementById(`stock-${flash}`)?.scrollIntoView({ block: 'center' })
    const timer = setTimeout(() => setFlash(null), 2600) // as long as the .flash outline lasts
    return () => clearTimeout(timer)
  }, [flashShown, flash])

  const load = async () => { await Promise.all([stock.reload(), ord.reload(), dfc.reload(), bsk.reload(), locations.reload()]) }

  // Same order as Statuss: the user's custom order (the printers list comes back in it; cached, shared).
  const printers = useApiData<Printer[]>('printers', api.printers, [])
  const rank = new Map(printers.data.map((p, i) => [p.id, i]))
  const inCompany = rows.filter((r) => !company || r.company === company)
    .sort((a, b) => (rank.get(a.printer_id) ?? 1e9) - (rank.get(b.printer_id) ?? 1e9)) // stable: toners keep their order
  const openOrders = orders.filter((o) => !company || o.company === company)
  const defects = dfc.data.filter((o) => !company || o.company === company)

  // One entry per printer with all its cartridges; filters pick printers, not single rows.
  const byPrinter = new Map<number, StockRow[]>()
  for (const r of inCompany) byPrinter.set(r.printer_id, [...(byPrinter.get(r.printer_id) ?? []), r])
  const groups = [...byPrinter.values()].filter((list) =>
    (!onlyLow || list.some((r) => r.low)) &&
    list.some((r) => matches(query, r.location, r.model, r.code, r.ip)))
  // Opening a card closes the one that was open. Animated on desktop: the cards grow/shrink and glide into place.
  const toggle = (id: number) => withViewTransition(() => setOpenId((cur) => (cur === id ? null : id)))

  // The basket ("Grozs"), per printer: what is still missing to reach the norm (after subtracting what is
  // already on order) plus whatever was added by hand ("Pievienot grozam" on a toner) — the two add up.
  const suggest = new Map<number, { loc: string; items: Need[] }>()
  const line = (printerId: number, loc: string, item: Omit<Need, 'qty' | 'added' | 'plannedIds'>) => {
    const s = suggest.get(printerId) ?? { loc, items: [] }
    suggest.set(printerId, s)
    let it = s.items.find((x) => x.toner_id === item.toner_id)
    if (!it) s.items.push(it = { ...item, qty: 0, added: 0, plannedIds: [] })
    return it
  }
  for (const r of inCompany) {
    const need = missing(r)
    if (need > 0) line(r.printer_id, r.location, { printer_id: r.printer_id, toner_id: r.toner_id, code: r.code, color: r.color, kind: r.kind, company: r.company, model: r.model }).qty += need
  }
  for (const o of bsk.data.filter((o) => !company || o.company === company).sort((a, b) => (rank.get(a.printer_id) ?? 1e9) - (rank.get(b.printer_id) ?? 1e9))) {
    const it = line(o.printer_id, o.location, { printer_id: o.printer_id, toner_id: o.toner_id, code: o.code, color: o.color, kind: o.kind, company: o.company, model: o.model })
    it.qty += o.qty
    it.added += o.qty
    it.plannedIds.push(o.id)
  }
  const basket = [...suggest.entries()].sort(([a], [b]) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9))
  const needTotal = basket.reduce((n, [, s]) => n + s.items.reduce((m, i) => m + i.qty, 0), 0)
  const addedTotal = basket.reduce((n, [, s]) => n + s.items.reduce((m, i) => m + i.added, 0), 0)
  const normTotal = needTotal - addedTotal
  // The basket is shown in two parts, each a list of printers with their toners: what is missing to the norm
  // (the app puts it there by itself) and what was added on top by hand. A toner can be in both.
  const part = (pick: (i: Need) => number) => basket
    .map(([id, s]) => ({ id, loc: s.loc, items: s.items.filter((i) => pick(i) > 0).map((i) => ({ ...i, qty: pick(i) })) }))
    .filter((p) => p.items.length > 0)
  const normPart = part((i) => i.qty - i.added)
  const extraPart = part((i) => i.added)
  const orderedTotal = openOrders.reduce((n, o) => n + o.qty, 0)

  // ✉ on either list: the same e-mail text (one shared template), built from that list's items.
  const emailNeeded = () => setDlg({
    kind: 'email', source: 'Grozs', flavor: ORDER_EMAIL,
    items: basket.flatMap(([, s]) => s.items).map((i) => ({ company: i.company, model: i.model, code: i.code, color: i.color, kind: i.kind, qty: i.qty })),
  })
  // "Pasūtīts" holds purchases and warranty claims (tagged). Each has its own e-mail text and template:
  // ✉ in the header = the purchases; "Garantijas e-pasts" on a claim = all open claims.
  // "Defekti" (cartridges not handed over yet) uses the warranty text too: ✉ in its header = the whole list.
  const byPrinterOrder = (a: Order, b: Order) => (rank.get(a.printer_id) ?? 1e9) - (rank.get(b.printer_id) ?? 1e9)
  const claimItems = (list: Order[]): EmailItem[] => [...list].sort(byPrinterOrder).map((o) => ({
    company: o.company, model: o.model, code: o.code, color: o.color, kind: o.kind, qty: o.qty,
    printer: o.location, pct: o.removed_pct, defect: o.defect, pages: o.pages_printed,
  }))
  const emailDefects = () => setDlg({ kind: 'email', source: 'Defekti', flavor: WARRANTY_EMAIL, items: claimItems(defects) })
  const purchases = openOrders.filter((o) => !o.warranty)
  const emailOrdered = () => setDlg({
    kind: 'email', source: 'Pasūtīts', flavor: ORDER_EMAIL,
    items: [...purchases].sort(byPrinterOrder) // in the user's printer order, like "Jāpasūta" (the panel lists newest first)
      .map((o) => ({ company: o.company, model: o.model, code: o.code, color: o.color, kind: o.kind, qty: o.qty })),
  })
  const emailWarranty = () => setDlg({
    kind: 'email', source: 'Pasūtīts (garantija)', flavor: WARRANTY_EMAIL, items: claimItems(openOrders.filter((o) => o.warranty)),
  })
  const claimNote = (o: Order) => `${o.defect || 'defekts'}${o.removed_pct == null ? '' : `, izņemts pie ${o.removed_pct}%`}${
    o.pages_printed == null ? '' : `, ${fmtNum(o.pages_printed)} lapas`}`
  // Paperclip + count when a defect has photos/files; opens the same window as "Dati un faili" in its menu.
  const filesMark = (o: Order) => o.files > 0 && (
    <button className="files-mark" onClick={() => setDlg({ kind: 'defect', order: o })} title="Pievienotie faili"
      aria-label={`Faili: ${o.files}`}>{Icon.clip(13)}{o.files}</button>
  )
  const mailBtn = (onClick: () => void, list: string) => (
    <button className="icon-btn" onClick={onClick} aria-label={`E-pasta teksts: ${list}`} title={`E-pasta teksts no saraksta „${list}”`}>{Icon.mail(18)}</button>
  )


  return (
    <>
      <TopBar title={['Krājumi', 'un rezerve']} />
      <div className="cols">
        <div className="left">
          <div className="big">
            <div className="lab">Grozā vienības</div>
            <div className={needTotal > 0 ? 'num hot' : 'num'}>{needTotal}</div>
            <div className="sub">Trūkst līdz normai + pielikts papildus</div>
          </div>

          {/* The basket: nothing here is ordered yet. "Pasūtīt" moves a printer's cartridges of that part to
              "Pasūtīts". Two parts, each with its own heading and count. */}
          <section className="pane">
            <div className="rh">
              <h3 className="h-ic">{Icon.cart(20)}Grozs</h3>
              <div className="rh-tools">
                <span className="meta">{needTotal} gab.</span>
                {suggest.size > 0 && mailBtn(emailNeeded, 'Grozs')}
              </div>
            </div>
            {suggest.size === 0 && <p className="muted">Grozs ir tukšs: nekas netrūkst līdz normai un nekas nav pielikts.</p>}

            {normPart.length > 0 && (
              <div className="bpart">
                <div className="bpart__head" title="Lietotne šos ieliek pati: norma mīnus krājums mīnus jau pasūtītais">
                  <span>Trūkst līdz normai</span><b className="bpart__n hot">{normTotal}</b>
                </div>
                {normPart.map((p) => (
                  <div key={p.id} className="ord">
                    <span className="a"><b>{p.loc}</b>
                      <small className="needs">{p.items.map((i) => <span key={i.toner_id}><Dot color={i.color} />{i.code} ×{i.qty}</span>)}</small></span>
                    <button className="btn small" onClick={() => setDlg({ kind: 'suggest', loc: p.loc, items: p.items, extra: false })}>Pasūtīt</button>
                  </div>
                ))}
              </div>
            )}

            {extraPart.length > 0 && (
              <div className="bpart">
                <div className="bpart__head" title="Pielikts ar „Pievienot grozam” pie tonera; papildus tam, kas trūkst līdz normai">
                  <span>Pielikts papildus</span><b className="bpart__n">{addedTotal}</b>
                </div>
                {extraPart.map((p) => (
                  <div key={p.id} className="ord">
                    <span className="a"><b>{p.loc}</b>
                      <small className="needs">{p.items.map((i) => (
                        <span key={i.toner_id}>
                          <Dot color={i.color} />{i.code} ×{i.qty}
                          <button className="needs__x" onClick={() => setDlg({ kind: 'unbasket', loc: p.loc, item: i })}
                            title="Izņemt no groza" aria-label={`Izņemt no groza ${i.code} ×${i.qty}`}>{Icon.close(12)}</button>
                        </span>
                      ))}</small></span>
                    <button className="btn small" onClick={() => setDlg({ kind: 'suggest', loc: p.loc, items: p.items, extra: true })}>Pasūtīt</button>
                  </div>
                ))}
              </div>
            )}
            {/* The whole basket at once (with a single line in it, that line's own "Pasūtīt" does the same). */}
            {normPart.length + extraPart.length > 1 && (
              <button className="btn primary recv-all-btn" onClick={() => setDlg({ kind: 'orderAll' })}>Pasūtīt visus ({needTotal} gab.)</button>
            )}
          </section>

          {/* Defective cartridges waiting to be handed over for warranty. Not "on order" yet: "Nodots garantijā"
              moves one to "Pasūtīts" (tagged Garantija). Only shown when there is something on it. */}
          {defects.length > 0 && (
            <section className="pane">
              <div className="rh">
                <h3>Defekti</h3>
                <div className="rh-tools">
                  <span className="meta">{defects.length} gab.</span>
                  {mailBtn(emailDefects, 'Defekti')}
                </div>
              </div>
              {defects.map((o) => (
                <div key={o.id} className="ord">
                  <span className="a">
                    <b><Dot color={o.color} /> {o.code}{filesMark(o)}</b>
                    <small>{o.location} · {fmtTime(o.created_ts)} · {claimNote(o)}{o.held_at && ` · atrodas: ${o.held_at}`}{o.note && ` · ${o.note}`}</small>
                  </span>
                  <ActionMenu code={`${o.code}, ${o.location}`} items={[
                    { label: 'Nodot garantijā', run: () => setDlg({ kind: 'send', orders: [o] }) },
                    { label: 'Dati un faili', run: () => setDlg({ kind: 'defect', order: o }) },
                    { label: 'Dzēst', run: () => setDlg({ kind: 'discard', order: o }), divider: true },
                  ]} />
                </div>
              ))}
              {defects.length > 1 && (
                <button className="btn primary recv-all-btn" onClick={() => setDlg({ kind: 'send', orders: defects })}>Nodot garantijā visus ({defects.length})</button>
              )}
            </section>
          )}

          <section className="pane">
            <div className="rh">
              <h3 className="h-ic">{Icon.truck(20)}Pasūtīts</h3>
              <div className="rh-tools">
                <span className="meta">{orderedTotal} gab. ceļā</span>
                {purchases.length > 0 && mailBtn(emailOrdered, 'Pasūtīts')}
              </div>
            </div>
            {openOrders.length === 0 && <p className="muted">Pašlaik nekas nav pasūtīts.</p>}
            {openOrders.map((o) => (
              <div key={o.id} className="ord">
                <span className="a">
                  <b><Dot color={o.color} /> {o.code} <span className="pv solid sm">×{o.qty}</span>{!!o.warranty && <span className="tag-w">Garantija</span>}{filesMark(o)}</b>
                  <small>
                    {o.location} · {fmtTime(o.created_ts)} · {o.created_by}
                    {!!o.warranty && ` · ${claimNote(o)}`}
                    {o.note && ` · ${o.note}`}
                  </small>
                </span>
                {/* One ⋮ per order (like the toner rows) instead of two buttons on every row.
                    A warranty claim: Saņemt = the replacement arrived, Noraidīts = the claim was rejected. */}
                <ActionMenu code={`${o.code}, ${o.location}`} items={[
                  { label: 'Saņemt', run: () => setDlg({ kind: 'receive', order: o }) },
                  ...(o.warranty ? [
                    { label: 'Garantijas e-pasts', run: emailWarranty },
                    { label: 'Dati un faili', run: () => setDlg({ kind: 'defect', order: o }) },
                  ] : []),
                  { label: o.warranty ? 'Noraidīts' : 'Atcelt', run: () => setDlg({ kind: 'cancel', order: o }), divider: true },
                ]} />
              </div>
            ))}
            {/* Everything arrived at once: one button for all. (With a single order its own "Saņemts" does the same.) */}
            {openOrders.length > 1 && (
              <button className="btn primary recv-all-btn" onClick={() => setDlg({ kind: 'receiveAll' })}>Saņemt visus ({orderedTotal} gab.)</button>
            )}
          </section>
        </div>

        <section className="pane">
          <div className="rh">
            <h3>Pēc printera</h3>
            <div className="rh-tools">
              <label className="check"><input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> Tikai zemie</label>
              <SearchBox value={query} onChange={setQuery} placeholder="Meklēt pēc printera, modeļa vai toneru koda…" />
            </div>
          </div>
          <div className="plist">
            {groups.map((list) => {
              const pid = list[0].printer_id
              const qty = list.reduce((n, r) => n + r.qty, 0)
              const norm = list.reduce((n, r) => n + r.optimal_qty, 0)
              const anyLow = list.some((r) => r.low)
              const isOpen = openId === pid || query !== '' // searching opens the matches
              return (
              <article key={pid} id={`stock-${pid}`} className={`grp${isOpen ? ' open' : ''}${flash === pid ? ' flash' : ''}`} style={vtName(`stock-${pid}`, 'card')}>
                <button className="gh-btn" aria-expanded={isOpen} onClick={() => toggle(pid)}>
                  <span className="gh-t"><b>{list[0].location}</b><span>{list[0].model}</span></span>
                  <span className={anyLow ? 'tot hot' : 'tot'} title={anyLow ? 'Kāds toneris ir zem normas' : 'Krājumā / norma'}>{qty}<small>/{norm}</small></span>
                  <span className={isOpen ? 'fold-ic open' : 'fold-ic'}>{Icon.chevron(18)}</span>
                </button>
                {isOpen && list.map((r) => (
                  <TonerRow key={r.toner_id} printerId={r.printer_id} printerName={r.location} allLocations={locations.data}
                    toner={{ id: r.toner_id, code: r.code, color: r.color, qty: r.qty, optimal_qty: r.optimal_qty, ordered: r.ordered, ordered_extra: r.ordered_extra, locations: r.locations }}
                    onChange={load} />
                ))}
              </article>
              )
            })}
            {groups.length === 0 && <p className="muted">{query ? 'Nekas netika atrasts' : 'Nav ierakstu'}</p>}
          </div>
        </section>
      </div>

      {dlg?.kind === 'send' && (
        <ConfirmDialog title="Nodot garantijā" confirmLabel={dlg.orders.length > 1 ? `Nodot (${dlg.orders.length})` : 'Nodot'} onClose={() => setDlg(null)}
          onConfirm={async () => { for (const o of dlg.orders) await api.sendWarranty(o.id); await load() }}>
          <ul className="dlg-list toners recv-all">
            {dlg.orders.map((o) => <li key={o.id}><Dot color={o.color} /><b>{o.code}</b><span className="recv-all__to">{o.location}</span></li>)}
          </ul>
          <p className="dlg-text muted">Ieraksts pāries uz „Pasūtīts” ar atzīmi „Garantija”: tiek gaidīts aizvietotājs, un toneris vairs netiks piedāvāts grozā.</p>
        </ConfirmDialog>
      )}
      {dlg?.kind === 'discard' && (
        <DestructiveDialog title="Dzēst no defektiem" confirmLabel="Dzēst" onClose={() => setDlg(null)}
          onConfirm={async () => { await api.deleteOrder(dlg.order.id); await load() }}>
          <p className="dlg-text">Dzēst <Dot color={dlg.order.color} /> <b>{dlg.order.code}</b> ({dlg.order.location}) no saraksta „Defekti”?<br />
            <span className="muted">Tas netiks nodots garantijā. Krājums nemainās.</span></p>
        </DestructiveDialog>
      )}
      {dlg?.kind === 'defect' && <DefectDialog order={dlg.order} onClose={() => setDlg(null)} onChange={load} />}
      {dlg?.kind === 'receiveAll' &&<ReceiveAllDialog orders={openOrders} places={activeLocs} onClose={() => setDlg(null)} onDone={load} />}
      {dlg?.kind === 'email' && <OrderEmailDialog rows={dlg.items} source={dlg.source} flavor={dlg.flavor} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'suggest' && (
        <ConfirmDialog title={`Pasūtīt: ${dlg.loc}`} confirmLabel="Atzīmēt kā pasūtītu" onClose={() => setDlg(null)}
          onConfirm={async () => { await api.createOrders(dlg.items.map(({ printer_id, toner_id, qty }) => ({ printer_id, toner_id, qty })), '', dlg.extra); await load() }}>
          <p className="dlg-text muted">{dlg.extra ? 'Pielikts papildus' : 'Trūkst līdz normai'}</p>
          <ul className="dlg-list toners">{dlg.items.map((i) => <li key={i.toner_id}><Dot color={i.color} /><b>{i.code}</b> ×{i.qty}</li>)}</ul>
          <p className="dlg-text muted">Toneri pāries no groza uz sarakstu „Pasūtīts”. Krājums pieaugs tikai tad, kad pasūtījums tiks atzīmēts kā saņemts.</p>
        </ConfirmDialog>
      )}
      {dlg?.kind === 'orderAll' && (
        <ConfirmDialog title="Pasūtīt visu grozu" confirmLabel={`Atzīmēt kā pasūtītu (${needTotal} gab.)`} onClose={() => setDlg(null)}
          onConfirm={async () => {
            // Two orders' worth: the part missing to the norm, then the extras (kept apart so the extras
            // don't count towards the norm). If the second fails, the first is already placed — reload shows it.
            const items = (list: typeof normPart) => list.flatMap((p) => p.items).map(({ printer_id, toner_id, qty }) => ({ printer_id, toner_id, qty }))
            try {
              if (normPart.length) await api.createOrders(items(normPart), '', false)
              if (extraPart.length) await api.createOrders(items(extraPart), '', true)
            } finally { await load() }
          }}>
          {[{ title: 'Trūkst līdz normai', total: normTotal, list: normPart }, { title: 'Pielikts papildus', total: addedTotal, list: extraPart }]
            .filter((s) => s.list.length > 0).map((s) => (
              <div key={s.title} className="recv-co">
                <div className="recv-co__head"><b>{s.title}</b> · {s.total} gab.</div>
                <ul className="dlg-list toners recv-all">
                  {s.list.flatMap((p) => p.items.map((i) => (
                    <li key={`${p.id}-${i.toner_id}`}><Dot color={i.color} /><b>{i.code}</b> ×{i.qty}<span className="recv-all__to">{p.loc}</span></li>
                  )))}
                </ul>
              </div>
            ))}
          <p className="dlg-text muted">Viss grozs pāries uz sarakstu „Pasūtīts”. Krājums pieaugs tikai tad, kad pasūtījumi tiks atzīmēti kā saņemti.</p>
        </ConfirmDialog>
      )}
      {dlg?.kind === 'unbasket' && (
        <DestructiveDialog title="Izņemt no groza" confirmLabel="Izņemt" onClose={() => setDlg(null)}
          onConfirm={async () => { for (const id of dlg.item.plannedIds) await api.deleteOrder(id); await load() }}>
          <p className="dlg-text">Izņemt no groza papildus pielikto <Dot color={dlg.item.color} /> <b>{dlg.item.code} ×{dlg.item.qty}</b> ({dlg.loc})?<br />
            <span className="muted">Tas, kas trūkst līdz normai, grozā paliek. Krājums un norma nemainās.</span></p>
        </DestructiveDialog>
      )}
      {dlg?.kind === 'receive' && <ReceiveDialog order={dlg.order} places={activeLocs} onClose={() => setDlg(null)} onDone={load} />}
      {dlg?.kind === 'cancel' && (
        <DestructiveDialog title={dlg.order.warranty ? 'Garantija noraidīta' : 'Atcelt pasūtījumu'}
          confirmLabel={dlg.order.warranty ? 'Jā, noraidīts' : 'Jā, atcelt'} onClose={() => setDlg(null)}
          onConfirm={async () => { await api.cancelOrder(dlg.order.id); await load() }}>
          {dlg.order.warranty
            ? <p className="dlg-text">Atzīmēt <Dot color={dlg.order.color} /> <b>{dlg.order.code}</b> ({dlg.order.location}) garantijas pieteikumu kā noraidītu?<br />
                <span className="muted">Aizvietotājs netiks gaidīts; krājums nemainās, un toneris atkal var parādīties grozā.</span></p>
            : <p className="dlg-text">Atcelt <Dot color={dlg.order.color} /> <b>{dlg.order.code} ×{dlg.order.qty}</b> ({dlg.order.location})? Krājums netiks mainīts.</p>}
        </DestructiveDialog>
      )}
    </>
  )
}
