import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, fmtClock, fmtTime, type Order, type Printer, type StoreLocation, type Supply, type UsageMonth } from '../api'
import { useApiData } from '../cache'
import { AnalyticsSheet } from '../components/AnalyticsSheet'
import { CompactBar } from '../components/CompactBar'
import { DefectDialog } from '../components/DefectFiles'
import { ReorderList } from '../components/ReorderList'
import { matches, SearchBox } from '../components/SearchBox'
import { Segmented } from '../components/Toggle'
import { TonerRow } from '../components/TonerRow'
import { TopBar } from '../components/TopBar'
import { useRemembered } from '../uiMemory'
import { useApp } from '../ctx'
import { Icon } from '../icons'
import { attentionReasons, DEFECT_STATUS, fmtDate, fmtDaysLeft, fmtHours, fmtNum, isImportantAlert, linkedItem, LOW_PCT, printerState, SOON_DAYS, splitSupplies, type Col } from '../lib'
import { vtName, withViewTransition } from '../viewTransition'
import { CDot, DotTile } from '../components/ColorDot'

/** Snapshot times are local (no timezone), so compare with the local date. */
function isToday(ts: string): boolean {
  const d = new Date()
  return ts.startsWith(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
}

const SPIN_MS = 800 // one turn of the refresh icon (matches .spin in index.css)

function Bars({ p, emptyText }: { p: Printer; emptyText: string }) {
  const { toners } = splitSupplies(p)
  if (toners.length === 0) return <span className="bars none">{emptyText}</span>
  return (
    <span className="bars" role="img" aria-label={toners.map((t) => `${t.name} ${t.pct ?? '–'}%`).join(', ')}>
      {toners.map((t) => (
        <span key={t.col} className="tb">
          {/* The bar keeps the toner's own colour even when low (so you can tell which is which); only the number turns orange. */}
          <i className="bar"><b className={t.col} style={{ width: `${t.pct ?? 0}%` }} /></i>
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
  // Company filter (desktop; '' = all), the same choice as on Krājumi. Remembered when you switch sections.
  const { companies } = useApp()
  const [company, setCompany] = useRemembered('filter.company', '')
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
  const [analytics, setAnalytics] = useState(false)
  const startSorting = () => { select(null); setQuery(''); setSorting(true) }
  const reorder = (next: Printer[]) => {
    // Optimistic: the new order shows at once; saved per user (Krājumi follows it too).
    const ids = next.map((p) => p.id)
    setPrinters((list) => [...next, ...list.filter((p) => !ids.includes(p.id))])
    api.setOrder(ids).catch(() => load())
  }

  const refreshBtn = (
    <button className={refreshing === 'all' ? 'rb ref-btn--top spin' : 'rb ref-btn--top'} onClick={() => refresh()} disabled={busy} aria-busy={refreshing === 'all'} aria-label="Atjaunot SNMP" title="Atjaunot SNMP">{Icon.refresh()}</button>
  )

  return (
    <>
      {/* "Analītika" and "Atjaunot SNMP" are both round buttons at the top on desktop. On phones four don't
          fit beside the title: Analītika stays at the top and the refresh moves to the left of the tools row
          (CSS shows one of the two refresh buttons). */}
      <TopBar title={['Printeru', 'statuss']}>
        <button className="rb" onClick={() => setAnalytics(true)} aria-haspopup="dialog" aria-label="Analītika" title="Analītika">{Icon.chart(22)}</button>
        {refreshBtn}
      </TopBar>
      <div className={open ? 'stage open' : 'stage'}>
        {/* The printers are white cards straight on the page (as on Krājumi), under a row of tools. */}
        <section className="list-pane" style={vtName('list-pane', 'list')}>
          {sorting
            ? <div className="splist__tools">
                <b className="splist__title">Kārtot printerus</b>
                <button className="btn small primary" onClick={() => setSorting(false)}>Gatavs</button>
              </div>
            : <div className="splist__tools">
                {/* Desktop only (CSS): the company filter, shared with Krājumi. */}
                <div className="splist__filters">
                  <Segmented label="Uzņēmums" value={company} onChange={setCompany}
                    options={[{ value: '', label: 'Visi' }, ...companies.map((c) => ({ value: c, label: c }))]} />
                </div>
                <div className="splist__acts">
                  <button className={refreshing === 'all' ? 'icon-btn ref-btn--tools spin' : 'icon-btn ref-btn--tools'} onClick={() => refresh()} disabled={busy} aria-busy={refreshing === 'all'} aria-label="Atjaunot SNMP" title="Atjaunot SNMP">{Icon.refresh(18)}</button>
                  <button className="icon-btn" onClick={startSorting} aria-label="Kārtot printerus" title="Kārtot (pielāgota secība)">{Icon.sort(18)}</button>
                  <SearchBox value={query} onChange={setQuery} placeholder="Meklēt pēc vietas, modeļa vai IP…" />
                </div>
              </div>}
          {sorting && <p className="mhint">Velciet aiz ≡, lai mainītu secību. Tā tiek saglabāta jums un tiek izmantota arī Krājumos.</p>}
          {loading && <p className="muted">Ielādē…</p>}
          {sorting
            ? <div className="pane splist__sort">
                <ReorderList items={inScope} label={(p) => p.location} onReorder={reorder}
                  render={(p) => <>
                    <span className="ic">{Icon.printer(18)}</span>
                    <span className="rrow__txt"><b>{p.location}</b><small>{[p.model, p.ip].filter(Boolean).join(' · ')}</small></span>
                  </>} />
              </div>
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
                  <span className="md">{[p.model, p.ip].filter(Boolean).join(' · ')}</span>
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
        {analytics && <AnalyticsSheet printers={inScope} onClose={() => setAnalytics(false)} />}
        <section ref={detailPane} className="pane detail-pane" inert={!open}>
          {shown && <Detail key={shown.id} p={shown} open={open} busy={busy} spinning={refreshing === shown.id} onRefresh={() => refresh(shown.id)} onClose={() => select(null)} onChange={load} allLocations={locs.data} />}
        </section>
      </div>
    </>
  )
}

/** A section that opens/closes from its heading; collapsed by default. Detail is keyed per printer, so it re-collapses. */
function Fold({ label, count, hot, startOpen = false, children }: { label: string; count: ReactNode; hot?: boolean; startOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(startOpen)
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
    <Fold label="Citi komponenti printerī" count={others.length}>
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

const MONTH_NAME = new Intl.DateTimeFormat('lv-LV', { month: 'long' })
const monthLabel = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${MONTH_NAME.format(new Date(y, mo - 1, 1))} ${y}` }
const currentMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }

/** Pages printed and cartridges used per month (last 12 with anything in them). The running month and the
 *  month the readings began are marked, and left out of the average, because they aren't whole months. */
function Usage({ printerId }: { printerId: number }) {
  const { data, loading } = useApiData<UsageMonth[]>(`usage-${printerId}`, () => api.printerUsage(printerId), [])
  const now = currentMonth()
  const whole = data.filter((m) => m.pages !== null && m.since === null && m.month !== now)
  const average = whole.length ? Math.round(whole.reduce((n, m) => n + m.pages!, 0) / whole.length) : null
  return (
    <section className="icard usage">
      <h3 className="lab">Lietojums pa mēnešiem</h3>
      {data.length === 0
        ? <p className="muted">{loading ? 'Ielādē…' : 'Vēl nav datu.'}</p>
        : <table>
            <thead><tr><th scope="col">Mēnesis</th><th scope="col" className="un">Lapas</th><th scope="col">Izlietotie toneri</th></tr></thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.month}>
                  <td>{monthLabel(m.month)}{m.month === now && <small>līdz šim</small>}</td>
                  <td className="un">
                    {fmtNum(m.pages)}
                    {m.since && <small title="Lapu skaitītājs tiek uzskaitīts no šīs dienas">no {m.since.slice(8)}.{m.since.slice(5, 7)}.</small>}
                  </td>
                  <td>
                    {m.toners.length === 0 && m.defects.length === 0 ? '–' : m.toners.map((t) => (
                      <span key={t.code} className="ut"><CDot color={t.color} kind={t.kind} />{t.code} ×{t.qty}</span>
                    ))}
                    {/* Cartridges marked defective that month: listed like the used ones, tagged "(Defekts)". */}
                    {m.defects.map((t) => (
                      <span key={`d-${t.code}`} className="ut"><CDot color={t.color} kind={t.kind} />{t.code} ×{t.qty} <span className="udef">(Defekts)</span></span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
      {average !== null && <p className="usage__avg">Vidēji {fmtNum(average)} lapas mēnesī (pilnie mēneši: {whole.length}).</p>}
    </section>
  )
}

/** Printer info → "Defekti": how many defective cartridges this printer has had and how they ended, then each
 *  one (toner, what was wrong, date, status). Tapping one opens its details and photos/files. */
function Defects({ printerId }: { printerId: number }) {
  const { data, loading, reload } = useApiData<Order[]>(`defects-${printerId}`, () => api.printerDefects(printerId), [])
  const [details, setDetails] = useState<Order | null>(null)
  const n = (status: Order['status']) => data.filter((o) => o.status === status).length
  const summary = [
    n('received') > 0 && `aizvietoti ${n('received')}`,
    n('cancelled') > 0 && `noraidīti ${n('cancelled')}`,
    n('ordered') > 0 && `garantijā ${n('ordered')}`,
    n('defect') > 0 && `nav nodoti ${n('defect')}`,
  ].filter(Boolean).join(' · ')
  return (
    <section className="icard usage">
      <h3 className="lab">Defekti{data.length > 0 && <small className="lab__n">{data.length}</small>}</h3>
      {data.length === 0
        ? <p className="muted">{loading ? 'Ielādē…' : 'Šim printerim nav bijis neviena defektēta tonera.'}</p>
        : <>
            <p className="usage__avg">Kopā {data.length}: {summary}.</p>
            <ul className="evlist">
              {data.map((o) => (
                <li key={o.id} className="ev">
                  <button className="ev__main" onClick={() => setDetails(o)} aria-haspopup="dialog">
                    <span className="ev__body">
                      <span className="ev__l1"><CDot color={o.color} kind={o.kind} /><b>{o.code}</b></span>
                      <span className="ev__l2">
                        {o.defect || 'Defekts'}
                        {o.removed_pct != null && ` · izņemts pie ${o.removed_pct}%`}
                        {o.pages_printed != null && ` · ${fmtNum(o.pages_printed)} lapas`}
                        {o.files > 0 && <span className="ev__files">{Icon.clip(12)}{o.files}</span>}
                      </span>
                    </span>
                    <span className="dfx"><b className={`dfx__st ${o.status}`}>{DEFECT_STATUS[o.status].label}</b><small>{fmtDate(o.created_ts)}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          </>}
      {details && <DefectDialog order={details} onClose={() => setDetails(null)} onChange={() => { reload().catch(() => {}) }} />}
    </section>
  )
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
            {p.ip
              ? <>
                  <Row k="IP adrese"><a href={`http://${p.ip}`} target="_blank" rel="noreferrer">{p.ip}</a></Row>
                  <Row k="Hostname">{snap?.hostname || '–'}</Row>
                  <Row k="SNMP">{p.snmp_enabled ? (st.offline ? 'Nav atbildes' : 'Ieslēgts') : 'Izslēgts'}</Row>
                  <Row k="Tīmekļa saskarne"><a href={`http://${p.ip}`} target="_blank" rel="noreferrer">Atvērt ↗</a></Row>
                </>
              : <Row k="IP adrese">Nav tīklā</Row>}
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
        <Usage printerId={p.id} />
        <Defects printerId={p.id} />
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
  const { toners, drums, others } = splitSupplies(p)
  // Show the cartridge code (from the printer's linked toners) instead of "Toner Black"; the dot already shows the colour.
  const codeFor = (col: Col) => linkedItem(p, 'toner', col)?.code
  // Reserve in the same colour order as the levels (K, C, M, Y; anything without a colour last), so on
  // desktop each toner sits beside its own reserve row.
  const rank = (color: string) => { const i = 'kcmy'.indexOf(color.toLowerCase()); return color && i >= 0 ? i : 9 }
  const kindRank = (kind: string) => (kind === 'toner' ? 0 : kind === 'drum' ? 1 : 2) // toners, then drums, then the rest
  const reserve = [...p.toners].sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || rank(a.color) - rank(b.color) || a.code.localeCompare(b.code))
  const resOther = reserve.filter((t) => t.kind !== 'toner' && t.kind !== 'drum')
  type Item = Printer['toners'][number]
  /** The reserve rows of one kind in the order of the levels on the left: each item at the position of its own
   *  level, `null` (an empty slot, desktop only) where a level has nothing in the reserve — e.g. a drum the
   *  printer reports that isn't linked. Items with no level of their own follow at the end. */
  const beside = (levels: { col: Col | '' }[], kind: 'toner' | 'drum'): (Item | null)[] => {
    const left = new Set(reserve.filter((t) => t.kind === kind))
    const out: (Item | null)[] = levels.map((l) => {
      const it = linkedItem(p, kind, l.col)
      if (!it || !left.has(it)) return null // not linked, or already placed (one drum code for several colours)
      left.delete(it)
      return it
    })
    while (out.length && out[out.length - 1] === null) out.pop()
    return [...out, ...reserve.filter((t) => left.has(t))]
  }
  const resToners = beside(toners, 'toner')
  const resDrums = beside(drums, 'drum')
  const row = (t: Item | null, i: number) => (t
    ? <TonerRow key={t.id} printerId={p.id} printerName={p.location} toner={t} allLocations={allLocations} emptiesDefault={p.empties_location_id} onChange={onChange} />
    : <div key={`gap-${i}`} className="t-gap" aria-hidden="true" />)
  const alerts = snap?.reachable && snap.alerts ? snap.alerts.split(' | ').filter((a) => a.trim()) : [] // blank = a printer sent an empty alert
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
          {p.ip && <button className={spinning ? 'icon-btn spin' : 'icon-btn'} onClick={onRefresh} disabled={busy} aria-busy={spinning} aria-label="Atjaunot printeri" title="Atjaunot šo printeri">{Icon.refresh(18)}</button>}
          <button className="icon-btn close-x" onClick={onClose} aria-label="Aizvērt">{Icon.close(18)}</button>
        </div>
      </div>

      {/* Grid areas: desktop = stats / (toners + others | reserve); phone = separate cards in the order
          stats, toners, reserve, others. */}
      <div className="dgrid">
        <div className="d-stats">
          {/* One compact line: uptime, last update, pages today (value + small label inline). */}
          <div className="stats-row">
            {!p.ip
              ? <span className="stat"><span className="tag ok">Nav tīklā</span></span>
              : st.offline
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

        {/* What the printer itself reports. On desktop this wrapper dissolves (display: contents) and its four
            parts sit in the grid beside the matching parts of the reserve; on the phone it is one card. */}
        <div className="d-levels">
          <div className="lab d-th">Toneri printerī</div>
          <div className="d-tl">
          {toners.length === 0 && (
            <p className="muted pad">{!p.ip ? 'Printeris nav tīklā, tāpēc toneru līmeņi netiek nolasīti. Zemāk ir tā rezerve.' : st.offline ? `Nav SNMP datu. Pēdējais mēģinājums ${snap ? fmtTime(snap.ts) : ''}.` : 'Nav SNMP datu par toneriem.'}</p>
          )}
          {toners.map((t) => (
            <div key={t.col} className="sp">
              <span className="dot"><i className={t.col} /></span>
              <span className="n" title={`Toner ${t.name}`}>
                {codeFor(t.col) ?? `Toner ${t.name}`}
                {/* Forecast from this cartridge's own history; absent until there are a few days of readings. */}
                {t.days !== null && (
                  <small className={t.days <= SOON_DAYS ? 'left hot' : 'left'}
                    title={`Prognoze pēc pēdējo dienu patēriņa: pietiks apmēram ${t.days} d.`}>{fmtDaysLeft(t.days)}</small>
                )}
              </span>
              <span className="tr"><i className={t.col} style={{ width: `${t.pct ?? 0}%` }} /></span>
              <span className={t.pct !== null && t.pct < LOW_PCT ? 'pv hot' : 'pv'}>{t.pct === null ? '–' : `${t.pct}%`}</span>
            </div>
          ))}
          </div>
          {/* Drums the printer reports: same rows, named by the linked drum's code when there is one. */}
          {drums.length > 0 && <div className="lab d-dh">Drumi printerī</div>}
          {drums.length > 0 && <div className="d-dl">{drums.map((d) => (
            <div key={d.idx} className="sp">
              <DotTile color={d.col} kind="drum" />
              <span className="n" title={`Drums${d.name ? ` ${d.name}` : ''}`}>
                {linkedItem(p, 'drum', d.col)?.code ?? `Drums${d.name ? ` ${d.name}` : ''}`}
                {d.days !== null && (
                  <small className={d.days <= SOON_DAYS ? 'left hot' : 'left'}
                    title={`Prognoze pēc pēdējo dienu nolietojuma: pietiks apmēram ${d.days} d.`}>{fmtDaysLeft(d.days)}</small>
                )}
              </span>
              <span className="tr"><i className={d.col || 'g'} style={{ width: `${d.pct ?? 0}%` }} /></span>
              <span className={d.pct !== null && d.pct < LOW_PCT ? 'pv hot' : 'pv'}>{d.pct === null ? '–' : `${d.pct}%`}</span>
            </div>
          ))}</div>}
        </div>

        {others.length > 0 && <div className="d-others"><Others key={p.id} others={others} /></div>}

        {/* Collapsed: the heading still shows the total (krājumā / norma), orange if something is below norm. */}
        <div className="d-reserve">
          {/* Desktop has the room (it sits beside the toner levels), so it starts open there; on the phone it
              starts closed, except for a printer that isn't on the network, where it is all there is to see. */}
          <Fold label="Rezerve" startOpen={!p.ip || window.matchMedia('(min-width: 801px)').matches} hot={p.toners.some((t) => t.qty < t.optimal_qty)}
            count={`${p.toners.reduce((n, t) => n + t.qty, 0)}/${p.toners.reduce((n, t) => n + t.optimal_qty, 0)}`}>
            {/* In parts, like the left side: toners, drums, the rest. On desktop each part is a grid cell level
                with the same part on the left. */}
            <div className="d-rt">
              {p.toners.length === 0 && <p className="muted pad">Printerim nav piesaistītu komponentu. Pievienojiet tos sadaļā Pārvaldība.</p>}
              {resToners.map(row)}
            </div>
            {resDrums.length > 0 && <div className="lab d-rdh">Drumi rezervē</div>}
            {resDrums.length > 0 && <div className="d-rd">{resDrums.map(row)}</div>}
            {resOther.length > 0 && <div className="d-ro"><div className="lab d-roh">Citi rezervē</div>{resOther.map(row)}</div>}
          </Fold>
        </div>
      </div>
    </div>
  )
}
