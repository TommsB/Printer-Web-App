import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, fmtClock, fmtTime, type Printer, type StoreLocation, type Supply } from '../api'
import { useApiData } from '../cache'
import { CompactBar } from '../components/CompactBar'
import { ReorderList } from '../components/ReorderList'
import { matches, SearchBox } from '../components/SearchBox'
import { TonerRow } from '../components/TonerRow'
import { TopBar } from '../components/TopBar'
import { useApp } from '../ctx'
import { Icon } from '../icons'
import { attentionReasons, fmtHours, fmtNum, isImportantAlert, LOW_PCT, printerState, splitSupplies, type Col } from '../lib'
import { vtName, withViewTransition } from '../viewTransition'

/** Snapshot times are local (no timezone), so compare with the local date. */
function isToday(ts: string): boolean {
  const d = new Date()
  return ts.startsWith(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
}

const SPIN_MS = 800 // one turn of the refresh icon (matches .spin in index.css)
const barClass =(col: Col, pct: number | null) => (pct !== null && pct < LOW_PCT ? 'o' : col)

function Bars({ p, emptyText }: { p: Printer; emptyText: string }) {
  const { toners } = splitSupplies(p)
  if (toners.length === 0) return <span className="bars none">{emptyText}</span>
  return (
    <span className="bars" role="img" aria-label={toners.map((t) => `${t.name} ${t.pct ?? '–'}%`).join(', ')}>
      {toners.map((t) => (
        <span key={t.col} className="tb">
          <i className="bar"><b className={barClass(t.col, t.pct)} style={{ width: `${t.pct ?? 0}%` }} /></i>
          <small className={t.pct !== null && t.pct < LOW_PCT ? 'hot' : ''}>{t.pct === null ? '–' : `${t.pct}%`}</small>
        </span>
      ))}
    </span>
  )
}

/** Status badge on the printer icon: green ✓ = answers and can print, orange ! = answers but can't print
 *  (jam, door open, no paper… — see snmp.blocking_reasons), red × = no SNMP answer. Nothing when SNMP is off / no reading yet. */
function ConnBadge({ p }: { p: Printer }) {
  if (!p.snmp_enabled || !p.snapshot) return null
  const st = printerState(p)
  const [cls, text, icon] = st.offline ? ['bad', 'Nav SNMP savienojuma', Icon.close(9)]
    : st.blocked.length ? ['stop', `Nevar drukāt: ${st.blocked.join(', ')}`, Icon.alert(11)]
    : ['ok', 'SNMP savienojums ir, var drukāt', Icon.check(10)]
  return <span className={`conn ${cls}`} role="img" aria-label={text} title={text}>{icon}</span>
}

/** Amber dot = needs attention (maintenance / reserve below norm); hover or screen reader says why. */
function AttentionDot({ p }: { p: Printer }) {
  const why = attentionReasons(p)
  if (!why.length) return null
  const text = `Uzmanību: ${why.join(', ')}`
  return <i className="sdot" role="img" aria-label={text} title={text} />
}

export function PrintersPage() {
  const { company } = useApp()
  // Cached: shows the last copy instantly, refreshes in the background.
  const { data: printers, setData: setPrinters, loading, reload: load } = useApiData<Printer[]>('printers', api.printers, [])
  const locs = useApiData<StoreLocation[]>('locations', api.locations, [])
  // Which SNMP refresh is running: all printers (top button) or one printer (details button). Its icon spins.
  const [refreshing, setRefreshing] = useState<'all' | number | null>(null)
  const busy = refreshing !== null
  // The open printer lives in the URL (/?p=12): a reload keeps it open and the link can be shared.
  const [params, setParams] = useSearchParams()
  const selId = Number(params.get('p')) || null
  const [query, setQuery] = useState('')
  const lastShown = useRef<Printer | null>(null)

  const select = (id: number | null) => {
    const apply = () => setParams(id === null ? {} : { p: String(id) }, { replace: true })
    // Desktop: opening/closing resizes the list and slides the details in — animated as a view transition
    // (snapshots on the compositor) instead of animating CSS width. Switching printers, and phones, just apply.
    if ((id === null) !== (selId === null) && window.matchMedia('(min-width: 801px)').matches) {
      withViewTransition(apply, id === null ? 'panel-close' : 'panel-open')
    }
    else apply()
  }
  const onEscape = useEffectEvent(() => { if (selId !== null) select(null) })

  // Phone: the details cover the screen. Lock the list behind them (otherwise a swipe on short details
  // scrolls the list underneath), and start each opened printer at the top.
  const detailPane = useRef<HTMLElement>(null)
  useEffect(() => {
    if (selId === null) return
    if (detailPane.current) detailPane.current.scrollTop = 0
    const root = document.documentElement
    root.classList.add('detail-open')
    return () => root.classList.remove('detail-open')
  }, [selId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onEscape() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The server returns printers in the user's own order ("Pielāgota secība"), rearranged with "Kārtot".
  const inScope = printers.filter((p) => p.active && (!company || p.company === company))
  const rows = inScope.filter((p) => matches(query, p.location, p.model, p.ip, p.brand, p.company))
  const sel = inScope.find((p) => p.id === selId) ?? null
  if (sel) lastShown.current = sel
  const shown = sel ?? lastShown.current // keeps content while the panel animates out
  const open = sel !== null

  const refresh = async (id?: number) => {
    setRefreshing(id ?? 'all')
    const started = Date.now()
    try {
      await (id ? api.refreshOne(id) : api.refresh())
      await load()
    } finally {
      // Let the icon finish at least one full turn (SPIN_MS), so a quick refresh doesn't just twitch.
      const left = SPIN_MS - ((Date.now() - started) % SPIN_MS)
      setTimeout(() => setRefreshing(null), left < SPIN_MS ? left : 0)
    }
  }
  // "Kārtot": the list turns into a drag-to-reorder list (details closed, search cleared while sorting).
  const [sorting, setSorting] = useState(false)
  const startSorting = () => { select(null); setQuery(''); setSorting(true) }
  const reorder = (next: Printer[]) => {
    // Optimistic: the new order shows at once; saved per user (Krājumi follows it too).
    const ids = next.map((p) => p.id)
    setPrinters((list) => [...next, ...list.filter((p) => !ids.includes(p.id))])
    api.setOrder(ids).catch(() => load())
  }

  const refreshBtn = (
    <button className={refreshing === 'all' ? 'rb spin' : 'rb'} onClick={() => refresh()} disabled={busy} aria-busy={refreshing === 'all'} aria-label="Atjaunot SNMP" title="Atjaunot SNMP">{Icon.refresh()}</button>
  )

  return (
    <>
      <TopBar title={['Printeru', 'statuss']}>{refreshBtn}</TopBar>
      <div className={open ? 'stage open' : 'stage'}>
        <section className="pane list-pane" style={vtName('list-pane', 'pane')}>
          <div className="rh">
            <h3>{sorting ? 'Kārtot printerus' : 'Visi printeri'}</h3>
            {sorting
              ? <button className="btn small primary" onClick={() => setSorting(false)}>Gatavs</button>
              : <div className="rh-tools">
                  <button className="icon-btn" onClick={startSorting} aria-label="Kārtot printerus" title="Kārtot (pielāgota secība)">{Icon.sort(18)}</button>
                  <SearchBox value={query} onChange={setQuery} placeholder="Meklēt pēc vietas, modeļa vai IP…" />
                </div>}
          </div>
          {sorting && <p className="mhint">Velciet aiz ≡, lai mainītu secību. Tā tiek saglabāta jums un tiek izmantota arī Krājumos.</p>}
          {loading && <p className="muted">Ielādē…</p>}
          {sorting
            ? <ReorderList items={inScope} label={(p) => p.location} onReorder={reorder}
                render={(p) => <>
                  <span className="ic">{Icon.printer(18)}</span>
                  <span className="rrow__txt"><b>{p.location}</b><small>{p.model} · {p.ip}</small></span>
                </>} />
            : <div className="list">
            {rows.map((p) => {
              const st = printerState(p)
              return (
                // Clicking the selected printer again deselects it.
                <button key={p.id} className={p.id === selId ? 'item on' : 'item'} aria-pressed={p.id === selId} style={vtName(`printer-${p.id}`, 'row')}
                  onClick={() => select(p.id === selId ? null : p.id)}>
                  <span className="ic">{Icon.printer(20)}<AttentionDot p={p} /><ConnBadge p={p} /></span>
                  <span className="nm">
                    <span className="nm-t">{p.location}</span>
                  </span>
                  <span className="md">{p.model} · {p.ip}</span>
                  <span className={st.lineHot ? 'st bad' : 'st'}>{st.line}</span>
                  <Bars p={p} emptyText={st.offline ? 'Nav SNMP datu' : '–'} />
                  <span className="pg">{fmtNum(p.snapshot?.pages_today)}<small>lapas šodien</small></span>
                  <span className="pg up">{fmtHours(p.snapshot?.uptime_hours)}<small>stundas darbībā</small></span>
                  <span className="chev">{Icon.chevron()}</span>
                </button>
              )
            })}
            {!loading && rows.length === 0 && <p className="muted">{query ? 'Nekas netika atrasts' : 'Nav printeru'}</p>}
          </div>}
        </section>

        {/* inert while closed: hidden from screen readers and its buttons can't be tabbed to. */}
        <section ref={detailPane} className="pane detail-pane" inert={!open}>
          {shown && <Detail key={shown.id} p={shown} open={open} busy={busy} spinning={refreshing === shown.id} onRefresh={() => refresh(shown.id)} onClose={() => select(null)} onChange={load} allLocations={locs.data} />}
        </section>
      </div>
    </>
  )
}

/** A section that opens/closes from its heading; collapsed by default. Detail is keyed per printer, so it re-collapses. */
function Fold({ label, count, hot, children }: { label: string; count: ReactNode; hot?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={open ? 'fold open' : 'fold'}>
      <button className="fold-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{label} <small className={hot ? 'hot' : undefined}>{count}</small></span>
        <span className={open ? 'fold-ic open' : 'fold-ic'}>{Icon.chevron(18)}</span>
      </button>
      {open && children}
    </div>
  )
}

/** Drums, fuser, belts etc. */
function Others({ others }: { others: Supply[] }) {
  if (others.length === 0) return null
  return (
    <Fold label="Citi komponenti" count={others.length}>
      {others.map((s) => (
        <div key={s.idx} className="sp">
          <span className="dot"><i className="g" /></span>
          <span className="n">{s.description}</span>
          <span className="tr"><i className="k" style={{ width: `${s.pct ?? 0}%` }} /></span>
          <span className="pv">{s.pct}%</span>
        </div>
      ))}
    </Fold>
  )
}

/** One "label: value" line in the printer info cards. */
function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="irow"><dt>{k}</dt><dd>{children ?? '–'}</dd></div>
}

/** Printer info sub-view: identity, network and all the counters we have. */
function PrinterInfo({ p, onBack, headRef }: { p: Printer; onBack: () => void; headRef: (el: HTMLHeadingElement | null) => void }) {
  const snap = p.snapshot
  const st = printerState(p)
  const up = snap?.uptime_hours
  return (
    <div className="dn">
      <div className="dhead">
        <button className="icon-btn" onClick={onBack} aria-label="Atpakaļ uz printeri">{Icon.back(20)}</button>
        <h2 ref={headRef}>{p.location}<small>Informācija</small></h2>
      </div>
      <div className="igrid">
        <section className="icard">
          <h3 className="lab">Printeris</h3>
          <dl>
            <Row k="Modelis">{p.model || '–'}</Row>
            <Row k="Ražotājs">{p.brand || '–'}</Row>
            <Row k="Tips">{p.color_type || '–'}</Row>
            <Row k="Uzņēmums">{p.company || '–'}</Row>
            <Row k="Sērijas nr.">{snap?.serial || '–'}</Row>
            {p.notes && <Row k="Piezīmes">{p.notes}</Row>}
          </dl>
        </section>
        <section className="icard">
          <h3 className="lab">Tīkls</h3>
          <dl>
            <Row k="IP adrese"><a href={`http://${p.ip}`} target="_blank" rel="noreferrer">{p.ip}</a></Row>
            <Row k="Hostname">{snap?.hostname || '–'}</Row>
            <Row k="SNMP">{p.snmp_enabled ? (st.offline ? 'Nav atbildes' : 'Ieslēgts') : 'Izslēgts'}</Row>
            <Row k="Tīmekļa saskarne"><a href={`http://${p.ip}`} target="_blank" rel="noreferrer">Atvērt ↗</a></Row>
          </dl>
        </section>
        <section className="icard">
          <h3 className="lab">Rādītāji</h3>
          <dl>
            <Row k="Lapas kopā">{fmtNum(snap?.page_count)}</Row>
            <Row k={snap?.pages_since ? `Lapas kopš ${fmtClock(snap.pages_since)}` : 'Lapas šodien'}>{fmtNum(snap?.pages_today)}</Row>
            <Row k="Darbības laiks">{up == null ? '–' : `${fmtHours(up)} h (${(up / 24).toFixed(1)} d)`}</Row>
            <Row k="Statuss">{st.line}</Row>
            <Row k="Atjaunots">{snap ? fmtTime(snap.ts) : '–'}</Row>
          </dl>
        </section>
      </div>
    </div>
  )
}

function Detail({ p, open, busy, spinning, onRefresh, onClose, onChange, allLocations }: {
  p: Printer; open: boolean; busy: boolean; spinning: boolean; onRefresh: () => void; onClose: () => void; onChange: () => void
  allLocations: StoreLocation[]
}) {
  const [view, setView] = useState<'main' | 'info'>('main') // Detail is keyed by printer id, so this resets per printer
  const [heading, setHeading] = useState<HTMLHeadingElement | null>(null)
  // Compact bar with the printer's name once its title scrolls away; < (phone) / × (desktop) leaves.
  const bar = (
    <CompactBar target={heading} active={open} className="cbar--detail" title={p.location}
      start={view === 'info'
        ? <button className="icon-btn" onClick={() => setView('main')} aria-label="Atpakaļ uz printeri">{Icon.back(18)}</button>
        : <>
            <button className="icon-btn back-btn" onClick={onClose} aria-label="Atpakaļ uz sarakstu">{Icon.back(18)}</button>
            <button className="icon-btn close-x" onClick={onClose} aria-label="Aizvērt">{Icon.close(16)}</button>
          </>} />
  )

  if (view === 'info') return <>{bar}<PrinterInfo p={p} onBack={() => setView('main')} headRef={setHeading} /></>
  return <>{bar}<DetailMain p={p} busy={busy} spinning={spinning} onRefresh={onRefresh} onClose={onClose} onChange={onChange}
    allLocations={allLocations} onInfo={() => setView('info')} headRef={setHeading} /></>
}

function DetailMain({ p, busy, spinning, onRefresh, onClose, onChange, allLocations, onInfo, headRef }: {
  p: Printer; busy: boolean; spinning: boolean; onRefresh: () => void; onClose: () => void; onChange: () => void
  allLocations: StoreLocation[]; onInfo: () => void; headRef: (el: HTMLHeadingElement | null) => void
}) {
  const st = printerState(p)
  const snap = p.snapshot
  const { toners, others } = splitSupplies(p)
  // Show the cartridge code (from the printer's linked toners) instead of "Toner Black"; the dot already shows the colour.
  const codeFor = (col: Col) => p.toners.find((t) => t.color.toLowerCase() === col)?.code
  const alerts = snap?.reachable && snap.alerts ? snap.alerts.split(' | ') : []
  // Reasons it can't print first (from error flags / critical alerts), then the other important messages.
  const important = [...st.blocked, ...alerts.filter((a) => isImportantAlert(a) && !st.blocked.includes(a))]
  const info = alerts.filter((a) => !isImportantAlert(a) && !st.blocked.includes(a))
  return (
    <div className="dn">
      {/* One header row: < (phone only) · title · actions on the right. */}
      <div className="dhead">
        <button className="icon-btn back-btn" onClick={onClose} aria-label="Atpakaļ uz sarakstu">{Icon.back(20)}</button>
        <h2 ref={headRef}>{p.location}</h2>
        <div className="dacts">
          <button className="icon-btn" onClick={onInfo} aria-label="Printera informācija" title="Printera informācija">{Icon.info(18)}</button>
          <button className={spinning ? 'icon-btn spin' : 'icon-btn'} onClick={onRefresh} disabled={busy} aria-busy={spinning} aria-label="Atjaunot printeri" title="Atjaunot šo printeri">{Icon.refresh(18)}</button>
          <button className="icon-btn close-x" onClick={onClose} aria-label="Aizvērt">{Icon.close(18)}</button>
        </div>
      </div>

      {/* Grid areas: desktop = stats / (toners + others | reserve); phone = separate cards in the order
          stats, toners, reserve, others. */}
      <div className="dgrid">
        <div className="d-stats">
          {/* One compact line: uptime, last update, pages today (value + small label inline). */}
          <div className="stats-row">
            {st.offline
              ? <span className="stat"><span className="tag bad">Nav pieejams</span></span>
              : <>
                  {st.blocked.length > 0 && <span className="stat"><span className="tag stop">Nevar drukāt</span></span>}
                  <span className="stat"><b>{fmtHours(snap?.uptime_hours)} h</b><small>darbībā</small></span>
                </>}
            {snap && <span className="stat"><b>{isToday(snap.ts) ? fmtClock(snap.ts) : fmtTime(snap.ts)}</b><small>atjaunots</small></span>}
            {!st.offline && snap && (
              <span className="stat" title={snap.page_count !== null ? `Kopā ${fmtNum(snap.page_count)} lapas` : undefined}>
                <b>{fmtNum(snap.pages_today)}</b>
                <small>{snap.pages_since ? `lapas kopš ${fmtClock(snap.pages_since)}` : 'lapas šodien'}</small>
              </span>
            )}
          </div>
          {/* Printer messages as one quiet line: orange only for real problems. */}
          {(important.length > 0 || info.length > 0) && (
            <div className="msgs">
              {important.map((m) => <span key={m} className="msg hot">{m}</span>)}
              {info.map((m) => <span key={m} className="msg">{m}</span>)}
            </div>
          )}
        </div>

        <div className="d-toners">
          <div className="lab">Toneri</div>
          {toners.length === 0 && (
            <p className="muted pad">{st.offline ? `Nav SNMP datu. Pēdējais mēģinājums ${snap ? fmtTime(snap.ts) : ''}.` : 'Nav SNMP datu par toneriem.'}</p>
          )}
          {toners.map((t) => (
            <div key={t.col} className="sp">
              <span className="dot"><i className={t.col} /></span>
              <span className="n" title={`Toner ${t.name}`}>{codeFor(t.col) ?? `Toner ${t.name}`}</span>
              <span className="tr"><i className={barClass(t.col, t.pct)} style={{ width: `${t.pct ?? 0}%` }} /></span>
              <span className={t.pct !== null && t.pct < LOW_PCT ? 'pv hot' : 'pv'}>{t.pct === null ? '–' : `${t.pct}%`}</span>
            </div>
          ))}
        </div>

        {others.length > 0 && <div className="d-others"><Others key={p.id} others={others} /></div>}

        {/* Collapsed: the heading still shows the total (krājumā / norma), orange if something is below norm. */}
        <div className="d-reserve">
          <Fold label="Rezerve" hot={p.toners.some((t) => t.qty < t.optimal_qty)}
            count={`${p.toners.reduce((n, t) => n + t.qty, 0)}/${p.toners.reduce((n, t) => n + t.optimal_qty, 0)}`}>
            {p.toners.length === 0 && <p className="muted pad">Printerim nav piesaistītu toneru. Pievienojiet tos sadaļā Pārvaldība.</p>}
            {p.toners.map((t) => (
              <TonerRow key={t.id} printerId={p.id} printerName={p.location} toner={t} allLocations={allLocations} onChange={onChange} />
            ))}
          </Fold>
        </div>
      </div>
    </div>
  )
}
