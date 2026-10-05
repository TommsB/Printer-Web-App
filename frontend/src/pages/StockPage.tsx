import { useState } from 'react'
import { api, fmtTime, type Order, type Printer, type StockRow, type StoreLocation } from '../api'
import { useApiData } from '../cache'
import { ConfirmDialog, DestructiveDialog } from '../components/Dialog'
import { ORDER_EMAIL, OrderEmailDialog, WARRANTY_EMAIL, type EmailFlavor, type EmailItem } from '../components/OrderEmailDialog'
import { matches, SearchBox } from '../components/SearchBox'
import { Stepper } from '../components/Stepper'
import { ActionMenu, TonerRow } from '../components/TonerRow'
import { TopBar } from '../components/TopBar'
import { useRemembered } from '../uiMemory'
import { useApp } from '../ctx'
import { Icon } from '../icons'
import { vtName, withViewTransition } from '../viewTransition'

/** One toner to order: which printer/toner, how many, and its colour for the dot. */
interface Need { printer_id: number; toner_id: number; code: string; color: string; qty: number }

const COLOR_LV: Record<string, string> = { K: 'melns', C: 'ciāns', M: 'purpurs', Y: 'dzeltens' }

/** Toner colour dot (grey when the toner has no colour set); the colour name is read out / shown on hover. */
function Dot({ color }: { color: string }) {
  const name = COLOR_LV[color.toUpperCase()]
  return <i className={`cdot ${color ? color.toLowerCase() : 'g'}`} {...(name && { role: 'img', 'aria-label': name, title: name })} />
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
  const list = [...orders].sort((a, b) => a.location.localeCompare(b.location, 'lv') || a.code.localeCompare(b.code))

  return (
    <ConfirmDialog title="Saņemt visus pasūtījumus" confirmLabel={`Saņemt ${total} gab.`} onClose={onClose} disabled={!place}
      onConfirm={async () => {
        await api.receiveOrders(orders.map((o) => ({ id: o.id, location_id: place })))
        setLast(place)
        await onDone()
      }}>
      <ul className="dlg-list toners recv-all">
        {list.map((o) => (
          <li key={o.id}><Dot color={o.color} /><b>{o.code}</b> ×{o.qty}{!!o.warranty && <span className="tag-w">Garantija</span>}<span className="recv-all__to">{o.location}</span></li>
        ))}
      </ul>
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
  | { kind: 'email'; source: string; flavor: EmailFlavor; items: EmailItem[] }
  | { kind: 'suggest'; loc: string; items: Need[] }
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
  const locations = useApiData<StoreLocation[]>('locations', api.locations, [])
  const activeLocs = locations.data.filter((l) => l.active)
  const [recvLoc, setRecvLoc] = useState(0)
  const rows = stock.data
  const orders = ord.data
  const [onlyLow, setOnlyLow] = useState(false)
  const [query, setQuery] = useState('')
  const [dlg, setDlg] = useState<Dlg>(null)
  const [qtyText, setQtyText] = useState('1')
  // One card open at a time; remembered when you switch sections and come back.
  const [openId, setOpenId] = useRemembered<number | null>('stock.open', null)

  const load = async () => { await Promise.all([stock.reload(), ord.reload(), dfc.reload(), locations.reload()]) }

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

  // Suggestions: what is still missing to reach the norm, after subtracting what is already on order.
  const suggest = new Map<number, { loc: string; items: Need[] }>()
  for (const r of inCompany) {
    const need = r.optimal_qty - r.qty - r.ordered
    if (need <= 0) continue
    const s = suggest.get(r.printer_id) ?? { loc: r.location, items: [] }
    s.items.push({ printer_id: r.printer_id, toner_id: r.toner_id, code: r.code, color: r.color, qty: need })
    suggest.set(r.printer_id, s)
  }
  const needTotal = [...suggest.values()].reduce((n, s) => n + s.items.reduce((m, i) => m + i.qty, 0), 0)
  const orderedTotal = openOrders.reduce((n, o) => n + o.qty, 0)

  // ✉ on either list: the same e-mail text (one shared template), built from that list's items.
  const emailNeeded = () => setDlg({
    kind: 'email', source: 'Jāpasūta', flavor: ORDER_EMAIL,
    items: inCompany.map((r) => ({ company: r.company, model: r.model, code: r.code, color: r.color, kind: r.kind, qty: r.optimal_qty - r.qty - r.ordered })),
  })
  // "Pasūtīts" holds purchases and warranty claims (tagged). Each has its own e-mail text and template:
  // ✉ in the header = the purchases; "Garantijas e-pasts" on a claim = all open claims.
  // "Defekti" (cartridges not handed over yet) uses the warranty text too: ✉ in its header = the whole list.
  const byPrinterOrder = (a: Order, b: Order) => (rank.get(a.printer_id) ?? 1e9) - (rank.get(b.printer_id) ?? 1e9)
  const claimItems = (list: Order[]): EmailItem[] => [...list].sort(byPrinterOrder).map((o) => ({
    company: o.company, model: o.model, code: o.code, color: o.color, kind: o.kind, qty: o.qty,
    printer: o.location, pct: o.removed_pct, defect: o.defect,
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
  const claimNote = (o: Order) => `${o.defect || 'defekts'}${o.removed_pct == null ? '' : `, izņemts pie ${o.removed_pct}%`}`
  const mailBtn = (onClick: () => void, list: string) => (
    <button className="icon-btn" onClick={onClick} aria-label={`E-pasta teksts: ${list}`} title={`E-pasta teksts no saraksta „${list}”`}>{Icon.mail(18)}</button>
  )

  const qtyN = Number(qtyText)
  const qtyValid = Number.isInteger(qtyN) && qtyN >= 1 && qtyN <= 1000

  return (
    <>
      <TopBar title={['Krājumi', 'un rezerve']} />
      <div className="cols">
        <div className="left">
          <div className="big">
            <div className="lab">Jāpasūta vienības</div>
            <div className={needTotal > 0 ? 'num hot' : 'num'}>{needTotal}</div>
            <div className="sub">Norma mīnus krājums mīnus jau pasūtītais</div>
          </div>

          <section className="pane">
            <div className="rh">
              <h3>Jāpasūta</h3>
              <div className="rh-tools">
                <span className="meta">{suggest.size} printeri</span>
                {suggest.size > 0 && mailBtn(emailNeeded, 'Jāpasūta')}
              </div>
            </div>
            {suggest.size === 0 && <p className="muted">Viss kārtībā, nekas nav jāpasūta.</p>}
            {[...suggest.entries()].map(([id, s]) => (
              <div key={id} className="ord">
                <span className="a"><b>{s.loc}</b>
                  <small className="needs">{s.items.map((i) => <span key={i.toner_id}><Dot color={i.color} />{i.code} ×{i.qty}</span>)}</small></span>
                <button className="btn small" onClick={() => setDlg({ kind: 'suggest', loc: s.loc, items: s.items })}>Pasūtīt</button>
              </div>
            ))}
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
                    <b><Dot color={o.color} /> {o.code}</b>
                    <small>{o.location} · {fmtTime(o.created_ts)} · {claimNote(o)}{o.note && ` · ${o.note}`}</small>
                  </span>
                  <ActionMenu code={`${o.code}, ${o.location}`} items={[
                    { label: 'Nodot garantijā', run: () => setDlg({ kind: 'send', orders: [o] }) },
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
              <h3>Pasūtīts</h3>
              <div className="rh-tools">
                <span className="meta">{orderedTotal} gab. ceļā</span>
                {purchases.length > 0 && mailBtn(emailOrdered, 'Pasūtīts')}
              </div>
            </div>
            {openOrders.length === 0 && <p className="muted">Pašlaik nekas nav pasūtīts.</p>}
            {openOrders.map((o) => (
              <div key={o.id} className="ord">
                <span className="a">
                  <b><Dot color={o.color} /> {o.code} <span className="pv solid sm">×{o.qty}</span>{!!o.warranty && <span className="tag-w">Garantija</span>}</b>
                  <small>
                    {o.location} · {fmtTime(o.created_ts)} · {o.created_by}
                    {!!o.warranty && ` · ${claimNote(o)}`}
                    {o.note && ` · ${o.note}`}
                  </small>
                </span>
                {/* One ⋮ per order (like the toner rows) instead of two buttons on every row.
                    A warranty claim: Saņemt = the replacement arrived, Noraidīts = the claim was rejected. */}
                <ActionMenu code={`${o.code}, ${o.location}`} items={[
                  { label: 'Saņemt', run: () => {
                    setQtyText(String(o.qty))
                    // Default: the printer's usual location, else the first one.
                    setRecvLoc(activeLocs.some((l) => l.id === o.default_location_id) ? o.default_location_id! : (activeLocs[0]?.id ?? 0))
                    setDlg({ kind: 'receive', order: o })
                  } },
                  ...(o.warranty ? [{ label: 'Garantijas e-pasts', run: emailWarranty }] : []),
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
              <article key={pid} className={isOpen ? 'grp open' : 'grp'} style={vtName(`stock-${pid}`, 'card')}>
                <button className="gh-btn" aria-expanded={isOpen} onClick={() => toggle(pid)}>
                  <span className="gh-t"><b>{list[0].location}</b><span>{list[0].model}</span></span>
                  <span className={anyLow ? 'tot hot' : 'tot'} title={anyLow ? 'Kāds toneris ir zem normas' : 'Krājumā / norma'}>{qty}<small>/{norm}</small></span>
                  <span className={isOpen ? 'fold-ic open' : 'fold-ic'}>{Icon.chevron(18)}</span>
                </button>
                {isOpen && list.map((r) => (
                  <TonerRow key={r.toner_id} printerId={r.printer_id} printerName={r.location} allLocations={locations.data}
                    toner={{ id: r.toner_id, code: r.code, color: r.color, qty: r.qty, optimal_qty: r.optimal_qty, ordered: r.ordered, locations: r.locations }}
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
          <p className="dlg-text muted">Ieraksts pāries uz „Pasūtīts” ar atzīmi „Garantija”: tiek gaidīts aizvietotājs, un toneris vairs netiks piedāvāts sarakstā „Jāpasūta”.</p>
        </ConfirmDialog>
      )}
      {dlg?.kind === 'discard' && (
        <DestructiveDialog title="Dzēst no defektiem" confirmLabel="Dzēst" onClose={() => setDlg(null)}
          onConfirm={async () => { await api.deleteOrder(dlg.order.id); await load() }}>
          <p className="dlg-text">Dzēst <Dot color={dlg.order.color} /> <b>{dlg.order.code}</b> ({dlg.order.location}) no saraksta „Defekti”?<br />
            <span className="muted">Tas netiks nodots garantijā. Krājums nemainās.</span></p>
        </DestructiveDialog>
      )}
      {dlg?.kind === 'receiveAll' &&<ReceiveAllDialog orders={openOrders} places={activeLocs} onClose={() => setDlg(null)} onDone={load} />}
      {dlg?.kind === 'email' && <OrderEmailDialog rows={dlg.items} source={dlg.source} flavor={dlg.flavor} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'suggest' && (
        <ConfirmDialog title={`Pasūtīt: ${dlg.loc}`} confirmLabel="Pievienot pasūtījumam" onClose={() => setDlg(null)}
          onConfirm={async () => { await api.createOrders(dlg.items.map(({ printer_id, toner_id, qty }) => ({ printer_id, toner_id, qty }))); await load() }}>
          <ul className="dlg-list toners">{dlg.items.map((i) => <li key={i.toner_id}><Dot color={i.color} /><b>{i.code}</b> ×{i.qty}</li>)}</ul>
          <p className="dlg-text muted">Krājums pieaugs tikai tad, kad pasūtījums tiks atzīmēts kā saņemts.</p>
        </ConfirmDialog>
      )}
      {dlg?.kind === 'receive' && (
        <ConfirmDialog title={dlg.order.warranty ? `Saņemt aizvietotāju: ${dlg.order.code}` : `Saņemt ${dlg.order.code}`}
          confirmLabel={qtyValid ? `Saņemts (+${qtyN} krājumā)` : 'Saņemts'} disabled={!qtyValid || !recvLoc} onClose={() => setDlg(null)}
          onConfirm={async () => { await api.receiveOrder(dlg.order.id, qtyN, recvLoc); await load() }}>
          <p className="dlg-text"><Dot color={dlg.order.color} /> <b>{dlg.order.code}</b> · {dlg.order.location}<br />
            <span className="muted">{dlg.order.warranty
              ? 'Garantijas aizvietotājs. Tas tiks pievienots rezervei.'
              : `Pasūtīts ×${dlg.order.qty}. Ja saņemts mazāk vai vairāk, izmainiet skaitu.`}</span></p>
          <div className="field"><span>Saņemtais daudzums</span>
            <Stepper label="Saņemtais daudzums" value={qtyText} onChange={setQtyText} min={1} max={1000} />
          </div>
          <label>Kur novietot
            <select value={recvLoc} onChange={(e) => setRecvLoc(+e.target.value)}>
              {activeLocs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        </ConfirmDialog>
      )}
      {dlg?.kind === 'cancel' && (
        <DestructiveDialog title={dlg.order.warranty ? 'Garantija noraidīta' : 'Atcelt pasūtījumu'}
          confirmLabel={dlg.order.warranty ? 'Jā, noraidīts' : 'Jā, atcelt'} onClose={() => setDlg(null)}
          onConfirm={async () => { await api.cancelOrder(dlg.order.id); await load() }}>
          {dlg.order.warranty
            ? <p className="dlg-text">Atzīmēt <Dot color={dlg.order.color} /> <b>{dlg.order.code}</b> ({dlg.order.location}) garantijas pieteikumu kā noraidītu?<br />
                <span className="muted">Aizvietotājs netiks gaidīts; krājums nemainās, un toneris atkal var parādīties sarakstā „Jāpasūta”.</span></p>
            : <p className="dlg-text">Atcelt <Dot color={dlg.order.color} /> <b>{dlg.order.code} ×{dlg.order.qty}</b> ({dlg.order.location})? Krājums netiks mainīts.</p>}
        </DestructiveDialog>
      )}
    </>
  )
}
