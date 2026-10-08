import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { api, type Analytics, type Printer } from '../api'
import { Icon } from '../icons'
import { classifySupply, fmtNum } from '../lib'
import { useRemembered } from '../uiMemory'

const TONERS: Record<string, { label: string; color: string }> = {
  K: { label: 'Black', color: 'var(--k)' }, C: { label: 'Cyan', color: 'var(--c)' },
  M: { label: 'Magenta', color: 'var(--m)' }, Y: { label: 'Yellow', color: 'var(--y)' },
}
/** "2026-10-08" → "08.10." */
const dayLabel = (d: string) => `${d.slice(8)}.${d.slice(5, 7)}.`
const sum = (list: number[]) => list.reduce((n, v) => n + v, 0)
const PERIODS = [7, 30, 90]
const COMPANY_ORDER = ['Tenax Panel', 'Tenapors', 'Tenax'] // the rows of the printer picker
const RISE_START = 0.12, RISE_STEP = 0.035 // seconds: the picker's cards start rising while the sheet is still coming up, one after another

/**
 * Per toner colour: how many percentage points of the cartridge went each day — the drop between one day's
 * last reading and the next. A level that went up (a new cartridge) adds nothing; a day without a reading
 * adds nothing either, and what went that day shows on the next day that has one.
 */
function tonerUse(data: Analytics, mono: boolean): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const s of data.supplies) {
    const c = classifySupply(s.description, mono)
    if (c?.kind !== 'toner') continue
    const drops = out.get(c.color) ?? data.days.map(() => 0)
    let prev: number | null = null
    s.pct.forEach((p, i) => {
      if (p === null) return
      if (prev !== null && p < prev) drops[i] += prev - p
      prev = p
    })
    out.set(c.color, drops)
  }
  return out
}

/** A round number at or above `v`, for the top of a chart's scale. */
function niceMax(v: number): number {
  if (v <= 4) return 4
  const pow = 10 ** Math.floor(Math.log10(v))
  return [1, 2, 4, 5, 10].map((m) => m * pow).find((m) => m >= v)!
}

/** Size of an element, kept up to date (the charts are drawn in real pixels, so their text never scales). */
function useSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size.w, size.h] as const
}

interface Series { key: string; label: string; color: string; values: (number | null)[] }

/**
 * Lines over the days, one per series (null = no data that day: a gap). Hovering or touching a day shows its
 * values. One series: the readout is its total ("kopā"). Several (the toner levels): the readout is each
 * one's latest value, `max` fixes the scale (0–100%) and `join` draws straight through days with no reading.
 */
function LineChart({ title, unit, days, series, max: fixedMax, join = false, compact }: {
  title: string; unit: string; days: string[]; series: Series[]; max?: number; join?: boolean; compact: boolean
}) {
  const [box, w, h] = useSize()
  const [hover, setHover] = useState<number | null>(null)
  // The plot takes whatever height the sheet has left for it (CSS), never less than MIN.
  // compact = phones, where everything has to fit on one screen without scrolling
  const MIN = compact ? 96 : 190
  const H = Math.max(MIN, h), L = compact ? 30 : 38, R = 10, T = compact ? 6 : 10, B = compact ? 18 : 24
  const n = days.length
  const step = Math.max(1, Math.ceil(n / (compact ? 3 : 5))) // a date label every so many days, counted back from today
  const max = fixedMax ?? niceMax(Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0))))
  const x = (i: number) => L + (i / (n - 1)) * Math.max(1, w - L - R)
  const y = (v: number) => T + (1 - v / max) * (H - T - B)
  // Unbroken runs of days that have a value: each is one stroke (and, for a single series, a filled area under it).
  // With `join` the days without a value are simply bridged: one stroke from the first value to the last (a
  // level doesn't jump about while the printer is off, so a straight line across the gap is what happened).
  const runsOf = (values: (number | null)[]) => {
    if (join) {
      const known = values.flatMap((v, i) => (v === null ? [] : [i]))
      return known.length ? [known] : []
    }
    const runs: number[][] = []
    values.forEach((v, i) => {
      if (v === null) return
      if (i > 0 && values[i - 1] !== null) runs[runs.length - 1].push(i)
      else runs.push([i])
    })
    return runs
  }
  const line = (values: (number | null)[], run: number[]) => run.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(values[i]!).toFixed(1)}`).join(' ')
  const single = series.length === 1
  const total = single ? sum(series[0].values.map((v) => v ?? 0)) : 0
  const latest = (values: (number | null)[]) => values.findLast((v) => v !== null) ?? null
  const at = (clientX: number, el: Element) => {
    const px = clientX - el.getBoundingClientRect().left
    setHover(Math.min(n - 1, Math.max(0, Math.round(((px - L) / Math.max(1, w - L - R)) * (n - 1)))))
  }
  const show = (v: number | null) => (v === null ? '–' : `${fmtNum(v)}${unit}`)

  return (
    <div className="an-card">
      <div className="an-card__head">
        <h3>{title}</h3>
        <span className="an-card__val">
          {hover !== null && <>{dayLabel(days[hover])} </>}
          {single
            ? hover === null ? <>kopā <b>{show(total)}</b></> : <b>{show(series[0].values[hover])}</b>
            : series.map((s) => <span key={s.key} className="an-card__s" title={s.label}><i style={{ background: s.color }} /><b>{show(hover === null ? latest(s.values) : s.values[hover])}</b></span>)}
        </span>
      </div>
      <div ref={box} className="an-plot" style={{ minHeight: MIN }}>
        {w > 0 && (
          <svg width={w} height={H} role="img"
            aria-label={single ? `${title}: kopā ${total}${unit} pēdējās ${n} dienās` : `${title}: ${series.map((s) => `${s.label} ${show(latest(s.values))}`).join(', ')}`}
            onPointerMove={(e) => at(e.clientX, e.currentTarget)} onPointerDown={(e) => at(e.clientX, e.currentTarget)} onPointerLeave={() => setHover(null)}>
            {[0, max / 2, max].map((t) => (
              <g key={t}>
                <line x1={L} x2={w - R} y1={y(t)} y2={y(t)} className="an-grid" />
                <text x={L - 8} y={y(t) + 4} textAnchor="end" className="an-tick">{fmtNum(t)}</text>
              </g>
            ))}
            {days.map((d, i) => ((n - 1 - i) % step === 0) && (
              <text key={d} x={x(i)} y={H - 6} textAnchor={i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle'} className="an-tick">{dayLabel(d)}</text>
            ))}
            {series.map((s) => runsOf(s.values).map((run) => (
              <g key={`${s.key}-${run[0]}`} style={{ color: s.color }}>
                {single && <path d={`${line(s.values, run)} L${x(run[run.length - 1]).toFixed(1)} ${y(0)} L${x(run[0]).toFixed(1)} ${y(0)} Z`} className="an-area" />}
                <path d={line(s.values, run)} pathLength={1} className="an-line" />
                {run.length === 1 && <circle cx={x(run[0])} cy={y(s.values[run[0]]!)} r="3" fill="currentColor" />}
              </g>
            )))}
            {hover !== null && series.some((s) => s.values[hover] !== null) && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={T} y2={y(0)} className="an-cursor" />
                {series.map((s) => s.values[hover] !== null && (
                  <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r="4.5" fill={s.color} stroke="var(--card)" strokeWidth="2" />
                ))}
              </g>
            )}
          </svg>
        )}
      </div>
    </div>
  )
}

/** Each toner's share of everything that was used. */
function Donut({ parts, compact }: { parts: { key: string; label: string; color: string; value: number }[]; compact: boolean }) {
  const total = sum(parts.map((p) => p.value))
  const r = 54, len = 2 * Math.PI * r
  const starts = parts.map((_, i) => (sum(parts.slice(0, i).map((p) => p.value)) / total) * len)
  return (
    <div className="an-card an-share">
      <div className="an-card__head"><h3>Toneru % patēriņa sadalījums</h3></div>
      {total === 0
        ? <p className="muted an-none">Šajās dienās toneru līmenis nav mainījies.</p>
        : <>
          <svg viewBox="0 0 140 140" className="an-donut" role="img" aria-label={parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}>
            <circle cx="70" cy="70" r={r} className="an-donut__bg" />
            {parts.map((p, i) => {
              const arc = (p.value / total) * len
              const gap = parts.length > 1 && arc > 6 ? 2.5 : 0 // a sliver of the card between the slices
              return p.value > 0 && (
                <circle key={p.key} cx="70" cy="70" r={r} className="an-donut__seg" stroke={p.color} transform="rotate(-90 70 70)"
                  strokeDasharray={`${arc - gap} ${len - arc + gap}`} strokeDashoffset={-starts[i]} style={{ '--len': len } as CSSProperties} />
              )
            })}
            {/* Phones: the number alone, dead centre. Desktop: the number with its caption under it. */}
            {compact
              ? <text x="70" y="70" textAnchor="middle" dominantBaseline="central" className="an-donut__n">{total}%</text>
              : <>
                <text x="70" y="68" textAnchor="middle" className="an-donut__n">{total}%</text>
                <text x="70" y="85" textAnchor="middle" className="an-donut__l">izlietots kopā</text>
              </>}
          </svg>
          {/* Relatīvais % = this colour's share of everything used; Fakts % = how much of its own cartridge went. */}
          <ul className="an-legend">
            <li className="an-legend__head" aria-hidden="true"><span>Krāsa</span><b>Relatīvais %</b><small>Fakts %</small></li>
            {parts.map((p) => (
              <li key={p.key}><i style={{ background: p.color }} /><span>{p.label}</span>
                <b aria-label={`relatīvais ${Math.round((p.value / total) * 100)}%`}>{Math.round((p.value / total) * 100)}%</b>
                <small aria-label={`fakts ${p.value}%`}>{p.value ? `−${p.value}%` : '0%'}</small></li>
            ))}
          </ul>
        </>}
    </div>
  )
}

function Charts({ data: all, mono }: { data: Analytics; mono: boolean }) {
  // A printer that was added (or first answered) less than 30 days ago: the charts start at its first day with
  // any data, so they aren't mostly empty. At least a week is always shown. (Also why 90 days can look like
  // 30 at first: levels are only stored per day since this was added.)
  const first = all.days.findIndex((_, i) => all.pages[i] !== null || all.supplies.some((s) => s.pct[i] !== null))
  const from = Math.max(0, Math.min(first < 0 ? 0 : first, all.days.length - 7))
  const data: Analytics = { days: all.days.slice(from), pages: all.pages.slice(from), supplies: all.supplies.map((s) => ({ ...s, pct: s.pct.slice(from) })) }
  const use = tonerUse(data, mono)
  const perDay = data.days.map((_, i) => sum([...use.values()].map((d) => d[i])))
  const parts = ['K', 'C', 'M', 'Y'].filter((c) => use.has(c)).map((c) => ({ key: c, ...TONERS[c], value: sum(use.get(c)!) }))
  const pages = data.pages.map((v) => v ?? 0)
  const counted = data.pages.filter((v) => v !== null).length
  // Days a toner level could be compared with the day before: the first day that has a reading is only the starting point.
  const tonerDays = Math.max(0, data.days.filter((_, i) => data.supplies.some((s) => s.pct[i] !== null && classifySupply(s.description, mono)?.kind === 'toner')).length - 1)
  const perDayAvg = tonerDays ? (sum(perDay) / tonerDays).toLocaleString('lv-LV', { maximumFractionDigits: 1 }) : null
  const compact = window.matchMedia('(max-width: 800px)').matches
  // Each toner's level at the end of every day (the first supply of a colour, should a printer report two).
  const levels: Series[] = ['K', 'C', 'M', 'Y'].flatMap((c) => {
    const supply = data.supplies.find((s) => { const k = classifySupply(s.description, mono); return k?.kind === 'toner' && k.color === c })
    return supply ? [{ key: c, ...TONERS[c], values: supply.pct }] : []
  })
  return (
    <div className="an">
      <div className="an-tiles">
        <div className="an-tile"><span>Lapas {data.days.length} dienās</span><b>{counted ? fmtNum(sum(pages)) : '–'}</b></div>
        <div className="an-tile"><span>Lapas vidēji dienā</span><b>{counted ? fmtNum(Math.round(sum(pages) / counted)) : '–'}</b></div>
        <div className="an-tile"><span>Toneru % patēriņš {data.days.length} dienās</span><b>{use.size ? `${sum(perDay)}%` : '–'}</b></div>
        <div className="an-tile"><span>Toneru % patēriņš vidēji dienā</span><b>{perDayAvg ? `${perDayAvg}%` : '–'}</b></div>
      </div>
      <div className="an-cols">
        <div className="an-lines">
          <LineChart title="Izdrukātās lapas dienā" unit="" days={data.days} series={[{ key: 'pages', label: 'Lapas', color: 'var(--ink)', values: data.pages }]} compact={compact} />
          {levels.length > 0
            ? <LineChart title="Toneru līmenis %" unit="%" days={data.days} series={levels} max={100} join compact={compact} />
            : <div className="an-card"><div className="an-card__head"><h3>Toneru līmenis %</h3></div><p className="muted an-none">Šis printeris pēdējās dienās nav ziņojis toneru līmeni.</p></div>}
          {/* Archived for now (kept so it can come back): toner used per day, all colours together.
              <LineChart title="Tonera patēriņš dienā" unit="%" days={data.days} series={[{ key: 'use', label: 'Patēriņš', color: 'var(--accent)', values: perDay }]} compact={compact} /> */}
        </div>
        {use.size > 0 && <Donut parts={parts} compact={compact} />}
      </div>
      <p className="mhint an-note">Līmenis ir katras dienas pēdējais nolasījums; lēciens uz augšu ir kasetnes nomaiņa. Patēriņš ir līmeņa kritums procentpunktos, nomaiņas diena netiek skaitīta.</p>
    </div>
  )
}

/**
 * "Analītika": slides up from the bottom (most of the screen; on phones nearly all of it, with everything in view at once). First asks which printer; then shows its last
 * 7, 30 or 90 days — pages per day, each toner's level day by day, and how the use splits between the colours.
 */
export function AnalyticsSheet({ printers, onClose }: { printers: Printer[]; onClose: () => void }) {
  const [id, setId] = useState<number | null>(null)
  const [days, setDays] = useRemembered('analytics.days', 30)
  const [loaded, setLoaded] = useState<{ id: number; days: number; data: Analytics } | null>(null)
  const [error, setError] = useState('')
  const list = printers.filter((p) => p.active && p.ip)
  const printer = list.find((p) => p.id === id) ?? null
  // The picker, by company: the three companies in this order, then anything else.
  const companies = [...COMPANY_ORDER, ...[...new Set(list.map((p) => p.company))].filter((c) => !COMPANY_ORDER.includes(c)).sort()]
  const groups = companies.map((company) => ({ company, printers: list.filter((p) => p.company === company) })).filter((g) => g.printers.length > 0)
    .map((g, i, all) => ({ ...g, first: sum(all.slice(0, i).map((x) => x.printers.length)) }))

  useEffect(() => {
    if (id === null) return
    let stale = false
    api.printerAnalytics(id, days).then((data) => { if (!stale) setLoaded({ id, days, data }) })
      .catch((e) => { if (!stale) setError(e instanceof Error ? e.message : 'Neizdevās ielādēt') })
    return () => { stale = true }
  }, [id, days])
  const fresh = printer !== null && loaded?.id === printer.id && loaded.days === days
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  // Phones (CSS): the page under the sheet doesn't scroll and shows no scrollbar.
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('sheet-open')
    return () => root.classList.remove('sheet-open')
  }, [])
  const pick = (next: number | null) => { setError(''); setId(next) }

  return (
    <>
      <div className="asheet__shade" onClick={onClose} />
      <section className="asheet" role="dialog" aria-modal="true" aria-label="Analītika">
        <header className="asheet__head">
          <h2>{Icon.chart(28)}Analītika</h2>
          {/* The period: a stopwatch icon with the number of days beside it, the browser's own list behind it. */}
          {printer && (
            <label className="icon-btn asheet__sel asheet__sel--days" title="Periods">
              {Icon.stopwatch(18)}<b>{days}</b>
              <select value={days} onChange={(e) => { setError(''); setDays(+e.target.value) }} aria-label="Periods">
                {PERIODS.map((d) => <option key={d} value={d}>Pēdējās {d} dienas</option>)}
              </select>
            </label>
          )}
          {/* Another printer: a printer icon with the browser's own list behind it (invisible, over the icon). */}
          {printer && (
            <label className="icon-btn asheet__sel" title="Cits printeris">
              {Icon.printer(18)}
              <select value={printer.id} onChange={(e) => pick(+e.target.value)} aria-label="Cits printeris">
                {list.map((p) => <option key={p.id} value={p.id}>{p.location}</option>)}
              </select>
            </label>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Aizvērt">{Icon.close(18)}</button>
        </header>

        {!printer && <>
          <p className="asheet__ask">Kuru printeri analizēt?</p>
          {/* One row of cards per company, in a fixed order. Once the sheet is up, the labels and cards rise into
              place one after another (the delay grows with each card's place in the whole list). */}
          {groups.map((g) => (
            <div key={g.company} className="asheet__co">
              <div className="asheet__co-name" style={{ animationDelay: `${RISE_START + g.first * RISE_STEP}s` }}>{g.company || 'Bez uzņēmuma'}</div>
              <div className="asheet__pick">
                {g.printers.map((p, i) => (
                  <button key={p.id} onClick={() => pick(p.id)} style={{ animationDelay: `${RISE_START + (g.first + i) * RISE_STEP}s` }}><b>{p.location}</b><span>{p.model}</span></button>
                ))}
              </div>
            </div>
          ))}
          {list.length === 0 && <p className="muted">Nav neviena printera ar SNMP datiem.</p>}
        </>}
        {/* Which printer the numbers below are for. */}
        {printer && (
          <div className="asheet__who">
            <b>{printer.location}</b>
            <span>{[printer.model, printer.company, printer.ip, printer.color_type].filter(Boolean).join(' · ')}</span>
          </div>
        )}
        {printer && error && <p className="alert">{error}</p>}
        {printer && !error && !fresh && <p className="muted asheet__wait">Ielādē…</p>}
        {printer && !error && fresh && <Charts key={`${printer.id}-${days}`} data={loaded!.data} mono={printer.color_type === 'Melnbalts'} />}
      </section>
    </>
  )
}
