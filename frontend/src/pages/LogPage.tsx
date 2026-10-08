import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, fmtClock, fmtTime, type Movement, type TonerEvent } from '../api'
import { invalidate, useApiData } from '../cache'
import { DestructiveDialog } from '../components/Dialog'
import { WarrantyForm } from '../components/TonerDialogs'
import { matches, SearchBox } from '../components/SearchBox'
import { TopBar } from '../components/TopBar'
import { useRemembered } from '../uiMemory'
import { useApp } from '../ctx'
import { Icon } from '../icons'
import { vtName, withViewTransition } from '../viewTransition'
import { DayGroup, useFoldedDays } from './log/DayGroup'
import { DefectList } from './log/DefectList'
import { ORDER_FILTERS, OrderHistory } from './log/OrderHistory'

/** How each kind of log entry looks. 'added' (old manual additions) is shown with the receipts. */
const KIND: Record<string, { label: string; icon: () => ReactNode; cls: string }> = {
  taken: { label: 'Izlietots', icon: () => Icon.trendDown(), cls: 'k-used' },
  received: { label: 'Saņemts', icon: () => Icon.trendUp(), cls: 'k-in' },
  added: { label: 'Pievienots', icon: () => Icon.plus(), cls: 'k-in' },
  moved: { label: 'Pārvietots', icon: () => Icon.swap(), cls: 'k-move' },
  correction: { label: 'Korekcija', icon: () => Icon.tune(), cls: 'k-fix' },
}
const FILTERS = [
  { key: 'all', label: 'Visi' },
  { key: 'taken', label: 'Izlietots' },
  { key: 'received', label: 'Saņemts' },
  { key: 'moved', label: 'Pārvietots' },
  { key: 'correction', label: 'Korekcijas' },
]
const filterKey = (reason: string) => (reason === 'added' ? 'received' : reason)
const COLOR_LV: Record<string, string> = { K: 'melnais', C: 'ciāna', M: 'purpura', Y: 'dzeltenais' }
const PAGE = 60
const VIEWS = [{ key: 'moves', label: 'Krājumu kustība' }, { key: 'orders', label: 'Pasūtījumi' }, { key: 'defects', label: 'Defekti' }]

/** The number on the right: −1 / +2, or ⇄ 1 for moves (total unchanged). */
function delta(m: Movement): { text: string; cls: string } {
  if (m.reason === 'moved') return { text: `⇄ ${m.delta}`, cls: 'd-move' }
  return m.delta < 0 ? { text: `−${-m.delta}`, cls: 'd-out' } : { text: `+${m.delta}`, cls: 'd-in' }
}

function where(m: Movement): string {
  if (m.reason === 'moved') return `${m.location ?? '?'} → ${m.to_location ?? '?'}`
  return m.location ?? ''
}

export function LogPage() {
  // Cached: shows the last copy instantly, refreshes in the background.
  const { data: rows, setData: setRows, reload } = useApiData<Movement[]>('movements', api.movements, [])
  const { events, reloadEvents, dropEvent } = useApp()
  // The selected filter (Visi / Izlietots / …) stays selected when you come back to Žurnāls.
  const [filter, setFilter] = useRemembered('log.filter', 'all')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [deleting, setDeleting] = useState<Movement | null>(null)
  const [confirming, setConfirming] = useState<TonerEvent | null>(null)
  const [claiming, setClaiming] = useState<TonerEvent | null>(null) // replacement that was a defect → warranty claim
  const [locId, setLocId] = useState(0)
  const [reviewError, setReviewError] = useState('')

  const shown = rows.filter((m) => (filter === 'all' || filterKey(m.reason) === filter)
    && matches(query, m.toner_code, m.printer_location, m.location, m.to_location, m.username, m.note))
  const visible = shown.slice(0, limit)

  // Group the visible entries by day (newest first, as the API returns them).
  const days: { day: string; items: Movement[] }[] = []
  for (const m of visible) {
    const day = m.ts.slice(0, 10)
    if (days.length && days[days.length - 1].day === day) days[days.length - 1].items.push(m)
    else days.push({ day, items: [m] })
  }

  // The reviewed item fades out, the panel shrinks and the log below glides up; then refresh from the server.
  const dismiss = async (e: TonerEvent) => {
    setReviewError('')
    try {
      await api.dismissEvent(e.id)
      await withViewTransition(() => dropEvent(e.id))
      reloadEvents()
    } catch (err) { setReviewError(`Neizdevās ignorēt: ${err instanceof Error ? err.message : 'Kļūda'}`) }
  }

  const days_ = useFoldedDays('log.foldedDays') // date headings fold their day's records

  // Two views of the page: stock movements (with the replacements to review) and the order history.
  const [view, setView] = useRemembered('log.view', 'moves')
  const [orderFilter, setOrderFilter] = useRemembered('log.orderFilter', 'all')

  // A tapped "nomainīts toneris" notification arrives as /log?event=12: show the review list, bring that
  // replacement into view and outline it for a moment. (Already confirmed or ignored = nothing to point at.)
  const [params, setParams] = useSearchParams()
  const wanted = Number(params.get('event')) || null
  const [flash, setFlash] = useState<number | null>(null)
  if (wanted !== null && flash !== wanted) { setView('moves'); setFlash(wanted) } // adjust state while rendering
  // One-time: the address goes back to plain /log, so coming back to Vēsture later doesn't jump again.
  useEffect(() => { if (wanted !== null) setParams({}, { replace: true }) }, [wanted, setParams])
  const flashShown = flash !== null && view === 'moves' && events.some((e) => e.id === flash)
  useEffect(() => {
    if (!flashShown) return
    document.getElementById(`review-${flash}`)?.scrollIntoView({ block: 'center' })
    const timer = setTimeout(() => setFlash(null), 2600) // as long as the .flash outline lasts
    return () => clearTimeout(timer)
  }, [flashShown, flash])

  const seg = (label: string, options: { key: string; label: string }[], value: string, pick: (k: string) => void) => (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} aria-pressed={value === o.key} className={value === o.key ? 'on' : ''} onClick={() => pick(o.key)}>{o.label}</button>
      ))}
    </div>
  )
  // Shown in the page and again in the compact top bar once you scroll down.
  const viewSwitch = seg('Skats', VIEWS, view, setView)
  const filters = seg('Ierakstu veids', FILTERS, filter, (k) => { setFilter(k); setLimit(PAGE) })
  const orderFilters = seg('Pasūtījuma statuss', ORDER_FILTERS, orderFilter, setOrderFilter)

  return (
    <>
      <TopBar title={['Kustība', 'un vēsture']}
        sticky={<div className="cbar__stack">{viewSwitch}{view === 'orders' ? orderFilters : view === 'defects' ? null : filters}</div>} />
      <div className="viewsw">{viewSwitch}</div>

      {view === 'orders' && <OrderHistory filter={orderFilter} filters={orderFilters} />}
      {view === 'defects' && <DefectList />}

      {/* Detected replacements waiting for review */}
      {view === 'moves' && events.length > 0 && (
        <section className="pane review" style={vtName('review', 'pane')}>
          <div className="rh">
            <h3>Jāpārbauda <span className="badge-n">{events.length}</span></h3>
          </div>
          <p className="review__hint">Printeris ziņo, ka toneris vai drums nomainīts. Apstipriniet, lai noņemtu 1 gab. no rezerves, vai ignorējiet.</p>
          {reviewError && <p className="error review__err" role="alert">{reviewError}</p>}
          <ul className="rvlist">
            {events.map((e) => {
              const canConfirm = e.toner_id !== null && e.qty > 0
              return (
                <li key={e.id} id={`review-${e.id}`} className={flash === e.id ? 'rv flash' : 'rv'} style={vtName(`review-${e.id}`, 'rv')}>
                  <span className="rv__head">
                    <span className="dot"><i className={e.color ? e.color.toLowerCase() : 'g'} /></span>
                    <span className="rv__txt">
                      <b>{e.toner_code ?? `${COLOR_LV[e.color] ?? ''} ${e.kind === 'drum' ? 'drums' : 'toneris'}`.trim()}</b>
                      {e.kind === 'drum' && <span className="tag-s">Drums</span>} · {e.printer_location}
                      <small>
                        {e.from_pct}% → {e.to_pct}% · {fmtTime(e.ts)}
                        {!e.toner_id && (e.kind === 'drum' ? ' · nav piesaistīta druma' : ' · nav piesaistīta tonera')}
                        {e.toner_id && e.qty === 0 && ' · rezervē nav neviena'}
                      </small>
                    </span>
                  </span>
                  <span className="rv__btns">
                    <button className="btn small primary" disabled={!canConfirm}
                      onClick={() => { setLocId(e.locations[0]?.location_id ?? 0); setConfirming(e) }}>Atzīmēt kā izlietotu</button>
                    {/* The old cartridge was defective (e.g. smearing at 60%): same as above + it goes on the Defekti list. */}
                    <button className="btn small" disabled={e.toner_id === null} title="Vecais toneris bija bojāts — pievienot sarakstam „Defekti”"
                      onClick={() => { setLocId(e.locations[0]?.location_id ?? 0); setClaiming(e) }}>Defekts</button>
                    <button className="btn small" onClick={() => dismiss(e)}>Ignorēt</button>
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {view === 'moves' && <section className="pane logpane" style={vtName('log', 'pane')}>
        <div className="log-tools">
          {filters}
          <SearchBox value={query} onChange={(v) => { setQuery(v); setLimit(PAGE) }} placeholder="Meklēt pēc tonera, printera, vietas vai lietotāja…" />
        </div>

        {days.length === 0 && <p className="muted empty">{rows.length === 0 ? 'Vēl nav neviena ieraksta.' : 'Nekas neatbilst filtram.'}</p>}

        {days.map(({ day, items }) => {
          const out = items.filter((m) => m.reason !== 'moved' && m.delta < 0).reduce((n, m) => n - m.delta, 0)
          const inn = items.filter((m) => m.reason !== 'moved' && m.delta > 0).reduce((n, m) => n + m.delta, 0)
          return (
            <DayGroup key={day} day={day} count={items.length} folded={days_.isFolded(day)} onToggle={() => days_.toggle(day)}
              summary={<>
                {out > 0 && <span className="d-out">−{out}</span>}
                {inn > 0 && <span className="d-in">+{inn}</span>}
              </>}>
              <ul className="evlist">
                {items.map((m) => {
                  const k = KIND[m.reason] ?? { label: m.reason, icon: () => Icon.clock(18), cls: '' }
                  const d = delta(m)
                  const isOpen = openId === m.id
                  return (
                    <li key={m.id} className={isOpen ? 'ev open' : 'ev'}>
                      <button className="ev__main" onClick={() => setOpenId(isOpen ? null : m.id)} aria-expanded={isOpen}>
                        <span className={`ev__ic ${k.cls}`}>{k.icon()}</span>
                        <span className="ev__body">
                          <span className="ev__l1">
                            <i className={`cdot ${m.toner_color ? m.toner_color.toLowerCase() : 'g'}`} />
                            <b>{m.toner_code}</b>
                            {m.printer_location && <span className="ev__pr">{m.printer_location}</span>}
                          </span>
                          <span className="ev__l2">{k.label}{where(m) && ` · ${where(m)}`} · {fmtClock(m.ts)}</span>
                        </span>
                        <span className={`ev__d ${d.cls}`}>{d.text}</span>
                      </button>
                      {isOpen && (
                        <div className="ev__more">
                          <dl>
                            {m.note && <><dt>Piezīme</dt><dd>{m.note}</dd></>}
                            <dt>Lietotājs</dt><dd>{m.username}</dd>
                            <dt>Laiks</dt><dd>{fmtTime(m.ts)}</dd>
                          </dl>
                          <button className="btn small danger del" onClick={() => setDeleting(m)}>{Icon.trash(16)} Dzēst ierakstu</button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </DayGroup>
          )
        })}

        {shown.length > limit && (
          <button className="btn more" onClick={() => setLimit(limit + PAGE)}>Rādīt vairāk ({shown.length - limit})</button>
        )}
      </section>}

      {claiming && claiming.toner_id !== null && (
        <WarrantyForm code={claiming.toner_code ?? ''} color={claiming.color} printerName={claiming.printer_location}
          initialPct={claiming.from_pct} onClose={() => setClaiming(null)}
          onCreate={async (v) => {
            // The spare that went into the printer comes off the reserve (as "Atzīmēt kā izlietotu" does) —
            // unless the app has none in stock for it; then the detection is just closed.
            if (claiming.qty > 0) await api.confirmEvent(claiming.id, locId)
            else await api.dismissEvent(claiming.id)
            // event_id: this replacement is when the defective cartridge came out (for its page count).
            return api.createWarranty({ printer_id: claiming.printer_id, toner_id: claiming.toner_id!, event_id: claiming.id, ...v })
          }}
          onDone={async () => {
            const id = claiming.id
            invalidate('defects', 'stock', 'printers', 'orders-all') // Krājumi must show the new entry on its Defekti list
            await withViewTransition(() => { dropEvent(id); setClaiming(null) })
            await Promise.all([reloadEvents(), reload()])
          }}>
          {claiming.qty === 0
            ? <p className="dlg-text muted">Rezervē šī tonera nav, tāpēc krājums netiek mainīts.</p>
            : claiming.locations.length > 1
              ? <label>Jaunais toneris paņemts no (rezerve −1)
                  <select value={locId} onChange={(e) => setLocId(+e.target.value)}>
                    {claiming.locations.map((l) => <option key={l.location_id} value={l.location_id}>{l.name} ({l.qty})</option>)}
                  </select>
                </label>
              : <p className="dlg-text muted">Printerī ieliktais jaunais toneris tiks noņemts no rezerves: {claiming.locations[0]?.name} · {claiming.qty} → {claiming.qty - 1}</p>}
        </WarrantyForm>
      )}

      {deleting && (
        <DestructiveDialog title="Dzēst ierakstu" confirmLabel="Dzēst" onClose={() => setDeleting(null)}
          onConfirm={async () => { await api.deleteMovement(deleting.id); setRows((l) => l.filter((x) => x.id !== deleting.id)); setOpenId(null) }}>
          <p className="dlg-text">
            Dzēst <b>{deleting.toner_code} {delta(deleting).text}</b> ({KIND[deleting.reason]?.label ?? deleting.reason}, {fmtTime(deleting.ts)})?<br />
            <span className="muted">Tiks dzēsts tikai vēstures ieraksts — krājuma daudzums nemainīsies.</span>
          </p>
        </DestructiveDialog>
      )}

      {confirming && (
        <DestructiveDialog title="Atzīmēt kā izlietotu" confirmLabel="Jā, izlietots" disabled={!locId} onClose={() => setConfirming(null)}
          onConfirm={async () => {
            await api.confirmEvent(confirming.id, locId)
            // Close the dialog and remove the item in one animated step, then refresh.
            const id = confirming.id
            await withViewTransition(() => { dropEvent(id); setConfirming(null) })
            await Promise.all([reloadEvents(), reload()])
          }}>
          <p className="dlg-text">
            Noņemt <b>1 gab. {confirming.toner_code}</b> no rezerves?<br />
            <span className="muted">{confirming.printer_location} · kopā {confirming.qty} → {confirming.qty - 1}</span>
          </p>
          {confirming.locations.length > 1
            ? <label>No kuras vietas
                <select value={locId} onChange={(e) => setLocId(+e.target.value)}>
                  {confirming.locations.map((l) => <option key={l.location_id} value={l.location_id}>{l.name} ({l.qty})</option>)}
                </select>
              </label>
            : confirming.locations[0] && <p className="dlg-text muted">No: {confirming.locations[0].name}</p>}
        </DestructiveDialog>
      )}
    </>
  )
}
