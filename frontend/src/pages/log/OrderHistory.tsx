import { useState, type ReactNode } from 'react'
import { api, fmtTime, parseTs, type Order } from '../../api'
import { invalidate, useApiData } from '../../cache'
import { DefectDialog } from '../../components/DefectFiles'
import { DeliveryDocsDialog } from '../../components/DeliveryDocs'
import { Dialog, DestructiveDialog } from '../../components/Dialog'
import { matches, SearchBox } from '../../components/SearchBox'
import { docsOf } from '../../files'
import { Icon } from '../../icons'
import { fmtDate, fmtEur, fmtNum } from '../../lib'
import { DayGroup, useFoldedDays } from './DayGroup'
import { CDot } from '../../components/ColorDot'

/** 'all' (the default) = orders that count: on the way + received. Cancelled ones only show under their own tab. */
export const ORDER_FILTERS = [
  { key: 'all', label: 'Pasūtītie' },
  { key: 'ordered', label: 'Ceļā' },
  { key: 'received', label: 'Saņemts' },
  { key: 'cancelled', label: 'Atcelts' },
]
const STATUS: Record<Order['status'], { label: string; icon: () => ReactNode; cls: string }> = {
  ordered: { label: 'Ceļā', icon: () => Icon.clock(18), cls: 'k-wait' },
  received: { label: 'Saņemts', icon: () => Icon.trendUp(), cls: 'k-in' }, // also a warranty replacement that arrived
  cancelled: { label: 'Atcelts', icon: () => Icon.close(16), cls: 'k-fix' },
  planned: { label: 'Grozā', icon: () => Icon.cart(16), cls: 'k-fix' }, // not listed here: lives in Krājumi → Grozs
  defect: { label: 'Defekts', icon: () => Icon.hazard(), cls: 'k-fix' }, // not listed here: lives in Krājumi → Defekti
}
const PAGE = 60
const SHORT = new Intl.DateTimeFormat('lv-LV', { day: '2-digit', month: '2-digit' })

/** Whole days from one server time to another (or to now). */
function daysBetween(from: string, to: string | null): number | null {
  const a = parseTs(from)
  const b = to ? parseTs(to) : new Date()
  return a && b ? Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000)) : null
}
/** "tajā pašā dienā" / "pēc 1 dienas" / "pēc 4 dienām" */
const after = (n: number) => (n === 0 ? 'tajā pašā dienā' : n % 10 === 1 && n % 100 !== 11 ? `pēc ${n} dienas` : `pēc ${n} dienām`)
const shortDate = (ts: string | null) => { const d = ts ? parseTs(ts) : null; return d ? SHORT.format(d) : '' }

/** The small second line of an order row: what happened to it and how long it took. */
function outcome(o: Order): string {
  // A warranty claim waits from the day it was handed over, not from the day the defect was noted.
  const days = daysBetween((o.warranty && o.sent_ts) || o.created_ts, o.resolved_ts)
  if (o.warranty) { // a warranty claim: handed over → replacement received / rejected
    if (o.status === 'ordered') return days === null ? 'Nodots garantijā' : days === 0 ? 'Nodots garantijā šodien' : `Garantijā · gaida ${days} d.`
    if (o.status === 'received') return `Saņemts aizvietotājs ${shortDate(o.resolved_ts)}${days === null ? '' : ` · ${after(days)}`}`
    return `Noraidīts ${shortDate(o.resolved_ts)}`
  }
  if (o.status === 'ordered') return days === null ? 'Ceļā' : days === 0 ? 'Ceļā · pasūtīts šodien' : `Ceļā · gaida ${days} d.`
  if (o.status === 'received') return `Saņemts ${shortDate(o.resolved_ts)}${days === null ? '' : ` · ${after(days)}`}`
  return `Atcelts ${shortDate(o.resolved_ts)}`
}

/** "89,90 € × 2 = 179,80 €" — what an order cost; an older order without a kept price shows today's component price. */
function priceText(o: Order): string {
  const qty = o.status === 'received' ? o.received_qty ?? o.qty : o.qty
  if (o.unit_price !== null) return `${fmtEur(o.unit_price, 2)} × ${qty} = ${fmtEur(o.unit_price * qty, 2)}`
  if (o.current_price !== null) return `${fmtEur(o.current_price, 2)} × ${qty} = ${fmtEur(o.current_price * qty, 2)} (pēc pašreizējās cenas)`
  return 'nav norādīta'
}

/** Correct what was paid per cartridge for one order (e.g. to match the invoice). Only this order changes — the
 *  component's price in Pārvaldība, used for new orders and the forecast, stays as it is. A number is required (0 for
 *  a free cartridge): an emptied price would quietly fall back to the component's current price again. */
function OrderPriceDialog({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: (o: Order) => void }) {
  const start = order.unit_price ?? order.current_price
  const [text, setText] = useState(start !== null ? String(start).replace('.', ',') : '')
  const clean = text.trim().replace(/\s/g, '').replace(',', '.')
  const price = Number(clean)
  const ok = clean !== '' && Number.isFinite(price) && price >= 0 && price <= 100000
  return (
    <Dialog.Frame title={`Cena: ${order.code}`} onClose={onClose} onSubmit={async () => onSaved(await api.setOrderPrice(order.id, price))}>
      <p className="dlg-text">{order.code} ×{order.qty} · {order.location} · pasūtīts {fmtDate(order.created_ts.slice(0, 10))}</p>
      <label>Cena par vienu (€)
        <input name="price" inputMode="decimal" autoComplete="off" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="piem. 89,90" aria-invalid={!ok} />
      </label>
      {!ok
        ? <p className="fnote err" role="alert">Ievadiet cenu kā skaitli, piem. 89,90 (bezmaksas kasetnei — 0).</p>
        : <p className="fnote">Mainās tikai šim pasūtījumam (Izmaksas → Faktiskās izmaksas). Komponenta cena Pārvaldībā paliek tā pati.{order.unit_price === null && ' Šim pasūtījumam cena vēl nav saglabāta — pagaidām tiek ņemta pašreizējā komponenta cena.'}</p>}
      <Dialog.Footer>
        <Dialog.Cancel />
        <Dialog.Confirm disabled={!ok}>Saglabāt</Dialog.Confirm>
      </Dialog.Footer>
    </Dialog.Frame>
  )
}

/**
 * Vēsture → Pasūtījumi: toner orders grouped by the day they were ordered (newest first). By default the ones
 * on the way and the received ones; cancelled orders are under "Atcelts". Read-only; orders are received/cancelled in Krājumi. `filter`/`filters` come from the
 * page, which also shows the filter buttons in the compact top bar.
 */
export function OrderHistory({ filter, filters }: { filter: string; filters: ReactNode }) {
  // Cached: shows the last copy instantly, refreshes in the background.
  const { data: orders, setData: setOrders, loading, reload } = useApiData<Order[]>('orders-all', () => api.orders('all'), [])
  const [details, setDetails] = useState<Order | null>(null) // a warranty claim's details and files
  const [notes, setNotes] = useState<{ day: string; company: string } | null>(null) // delivery notes of a company's orders of one day
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [deleting, setDeleting] = useState<Order | null>(null)
  const [pricing, setPricing] = useState<Order | null>(null) // the order whose price is being corrected
  const folds = useFoldedDays('log.foldedOrderDays') // date headings fold their day's orders

  // Defects not handed over yet and what is only in the basket aren't orders: they are in Krājumi, not here.
  const shown = orders.filter((o) => o.status !== 'defect' && o.status !== 'planned' && (filter === 'all' ? o.status !== 'cancelled' : o.status === filter)
    && matches(query, o.code, o.location, o.model, o.company, o.created_by, o.resolved_by, o.note))
  const visible = shown.slice(0, limit)

  // Group by the day the order was placed (the API returns newest first)…
  const days: { day: string; items: Order[] }[] = []
  for (const o of visible) {
    const day = o.created_ts.slice(0, 10)
    if (days.length && days[days.length - 1].day === day) days[days.length - 1].items.push(o)
    else days.push({ day, items: [o] })
  }
  // …and inside a day by company: each company gets its own delivery note ("pavadzīme"), attached to the group.
  const byCompany = (items: Order[]) => {
    const groups = new Map<string, Order[]>()
    for (const o of items) groups.set(o.company, [...(groups.get(o.company) ?? []), o])
    return [...groups].sort(([a], [b]) => (a === '') === (b === '') ? a.localeCompare(b, 'lv') : a === '' ? 1 : -1)
  }
  // A note covers everything of that company ordered that day that could arrive — also orders the current
  // filter or search hides (but not cancelled ones, and not defects that were never handed over).
  const covered = (day: string, company: string) => orders.filter((o) => o.company === company && o.created_ts.slice(0, 10) === day
    && (o.status === 'ordered' || o.status === 'received'))

  return (
    <section className="pane logpane">
      <div className="log-tools">
        {filters}
        <SearchBox value={query} onChange={(v) => { setQuery(v); setLimit(PAGE) }} placeholder="Meklēt pēc tonera, printera vai lietotāja…" />
      </div>

      {days.length === 0 && (
        <p className="muted empty">{loading && orders.length === 0 ? 'Ielādē…' : orders.length === 0 ? 'Vēl nav neviena pasūtījuma.' : 'Nekas neatbilst filtram.'}</p>
      )}

      {days.map(({ day, items }) => (
        <DayGroup key={day} day={day} count={items.length} folded={folds.isFolded(day)} onToggle={() => folds.toggle(day)}
          summary={<>pasūtīts {items.reduce((n, o) => n + o.qty, 0)} gab.</>}>
          {byCompany(items).map(([company, list]) => {
            const group = covered(day, company)
            const docs = docsOf(group)
            return (
          <div key={company} className="cgrp">
          <div className="cgrp__head">
            <b>{company || 'Bez uzņēmuma'}</b>
            {/* Paperclip right after the name: grey = no delivery note yet, green = attached.
                Nothing to attach a note to when the whole group was cancelled. */}
            {group.length > 0 && (
              <button className={docs.length ? 'clip-btn has' : 'clip-btn'} onClick={() => setNotes({ day, company })}
                title={docs.length ? `Pievienotie dokumenti (${docs.length})` : 'Pievienot dokumentu'}
                aria-label={`${docs.length ? `Pievienotie dokumenti (${docs.length})` : 'Pievienot dokumentu'}: ${company || 'bez uzņēmuma'}`}>
                {Icon.clip(16)}
              </button>
            )}
            <small>{list.reduce((n, o) => n + o.qty, 0)} gab.</small>
          </div>
          <ul className="evlist">
            {list.map((o) => {
              const s = STATUS[o.status]
              const isOpen = openId === o.id
              const took = o.status === 'received' ? daysBetween(o.created_ts, o.resolved_ts) : null
              return (
                <li key={o.id} className={isOpen ? 'ev open' : 'ev'}>
                  <button className="ev__main" onClick={() => setOpenId(isOpen ? null : o.id)} aria-expanded={isOpen}>
                    <span className={`ev__ic ${s.cls}`}>{s.icon()}</span>
                    <span className="ev__body">
                      <span className="ev__l1">
                        <CDot color={o.color} kind={o.kind} />
                        <b>{o.code}</b>
                        {!!o.warranty && <span className="tag-w">Garantija</span>}
                        <span className="ev__pr">{o.location}</span>
                      </span>
                      <span className="ev__l2">{outcome(o)}</span>
                    </span>
                    <span className={`ev__d ${o.status === 'cancelled' ? 'd-move struck' : 'd-move'}`}>×{o.qty}</span>
                  </button>
                  {isOpen && (
                    <div className="ev__more">
                      <dl>
                        {!!o.warranty && <>
                          <dt>Defekts</dt><dd>{o.defect || '–'}{o.removed_pct != null && ` · izņemts pie ${o.removed_pct}%`}</dd>
                          {o.pages_printed != null && <><dt>Izdrukāts</dt><dd>{fmtNum(o.pages_printed)} lapas ar šo kasetni</dd></>}
                          {o.held_at && o.status === 'ordered' && !o.sent_ts && <><dt>Atrodas</dt><dd>{o.held_at}</dd></>}
                        </>}
                        <dt>{o.warranty ? 'Atzīmēja' : 'Pasūtīja'}</dt><dd>{o.created_by} · {fmtTime(o.created_ts)}</dd>
                        {!!o.warranty && o.sent_ts && <><dt>Nodots garantijā</dt><dd>{o.sent_by} · {fmtTime(o.sent_ts)}</dd></>}
                        {o.status !== 'ordered' && <>
                          <dt>{o.status === 'received' ? 'Saņēma' : o.warranty ? 'Noraidīts' : 'Atcēla'}</dt>
                          <dd>{o.resolved_by ?? '–'}{o.resolved_ts && ` · ${fmtTime(o.resolved_ts)}`}</dd>
                        </>}
                        {o.status === 'received' && <>
                          <dt>Saņemts</dt>
                          <dd>{o.received_qty ?? o.qty} gab.{o.received_qty !== null && o.received_qty !== o.qty && ` (pasūtīts ${o.qty})`}</dd>
                        </>}
                        {took !== null && <><dt>Piegāde</dt><dd>{after(took)}</dd></>}
                        {/* What was paid (not for warranty replacements, which cost nothing): the price kept with the
                            order, or today's component price for an older order that has none; editable. */}
                        {!o.warranty && <>
                          <dt>Cena</dt>
                          <dd className="ev__price">
                            <span>{priceText(o)}</span>
                            <button type="button" className="ev__edit" onClick={() => setPricing(o)} aria-label={`Labot cenu: ${o.code}`}>{Icon.pencil(14)}Labot</button>
                          </dd>
                        </>}
                        <dt>Printeris</dt><dd>{[o.location, o.model, o.company].filter(Boolean).join(' · ')}</dd>
                        {o.note && <><dt>Piezīme</dt><dd>{o.note}</dd></>}
                      </dl>
                      {!!o.warranty && (
                        <button className="btn small del" onClick={() => setDetails(o)}>{Icon.clip(15)} Dati un faili{o.files > 0 && ` (${o.files})`}</button>
                      )}
                      <button className="btn small danger del" onClick={() => setDeleting(o)}>{Icon.trash(16)} Dzēst ierakstu</button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          </div>
            )
          })}
        </DayGroup>
      ))}

      {shown.length > limit && (
        <button className="btn more" onClick={() => setLimit(limit + PAGE)}>Rādīt vairāk ({shown.length - limit})</button>
      )}

      {notes && (
        <DeliveryDocsDialog title={`${notes.company || 'Bez uzņēmuma'} · pasūtīts ${fmtDate(notes.day)}`} orders={covered(notes.day, notes.company)}
          onClose={() => setNotes(null)} onChange={() => { reload().catch(() => {}) }} />
      )}
      {details && <DefectDialog order={details} onClose={() => setDetails(null)} onChange={() => { reload().catch(() => {}) }} />}
      {pricing && (
        <OrderPriceDialog order={pricing} onClose={() => setPricing(null)}
          onSaved={(saved) => {
            setOrders((l) => l.map((x) => (x.id === saved.id ? { ...x, unit_price: saved.unit_price } : x)))
            invalidate('costs-30') // the "≈ € mēnesī" figures and Izmaksas read it
          }} />
      )}

      {deleting && (
        <DestructiveDialog title="Dzēst pasūtījuma ierakstu" confirmLabel="Dzēst" onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteOrder(deleting.id)
            setOrders((l) => l.filter((x) => x.id !== deleting.id))
            setOpenId(null)
            // Krājumi shows open orders and "pasūtīts ×N" on toner rows: drop its cached copies so they reload.
            if (deleting.status === 'ordered') invalidate('orders', 'stock', 'printers')
          }}>
          <p className="dlg-text">
            Dzēst <b>{deleting.code} ×{deleting.qty}</b> ({STATUS[deleting.status].label.toLowerCase()}, {deleting.location})?<br />
            <span className="muted">
              {deleting.status === 'ordered'
                ? `${deleting.warranty ? 'Aizvietotājs' : 'Pasūtījums'} vēl nav saņemts: ieraksts pazudīs no „Pasūtīts”, un toneris atkal var parādīties grozā.`
                : 'Tiks dzēsts tikai pasūtījuma ieraksts — krājuma daudzums nemainīsies.'}
              {deleting.files > 0 && ` Kopā ar ierakstu tiks dzēsti arī tam pievienotie faili (${deleting.files}).`}
            </span>
          </p>
        </DestructiveDialog>
      )}
    </section>
  )
}
