import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { api, type Analytics, type AnalyticsPart, type Printer } from '../api'
import { Icon } from '../icons'
import { classifySupply, fmtNum } from '../lib'
import { useRemembered } from '../uiMemory'
import { Segmented } from './Toggle'

/** `ink` = the colour of a number written on that toner's colour (the pie's labels). */
const TONERS: Record<string, { label: string; color: string; ink: string }> = {
  K: { label: 'Black', color: 'var(--k)', ink: 'var(--on-ink)' }, C: { label: 'Cyan', color: 'var(--c)', ink: '#fff' },
  M: { label: 'Magenta', color: 'var(--m)', ink: '#fff' }, Y: { label: 'Yellow', color: 'var(--y)', ink: '#33332F' },
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
function tonerUse(data: AnalyticsPart, mono: boolean): Map<string, number[]> {
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

/** Size of an element, kept up to date (the level chart is drawn in real pixels, so its text never scales). */
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

/**
 * Where the charts start. A printer that was added (or first answered) less than the chosen period ago: at its
 * first day with any data, so they aren't mostly empty — at least a week is always shown. (Also why 90 days
 * can look like 30 at first: levels are only stored per day since this was added.)
 */
function dataStart(all: AnalyticsPart): number {
  const first = all.days.findIndex((_, i) => all.pages[i] !== null || all.supplies.some((s) => s.pct[i] !== null))
  return Math.max(0, Math.min(first < 0 ? 0 : first, all.days.length - 7))
}

/** A small ⓘ that shows a short explanation when tapped or clicked (and hides again on a second tap, Esc, or leaving it). */
function Hint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="hint">
      <button type="button" className="hint__btn" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)} onBlur={() => setOpen(false)}
        onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }}>{Icon.info(15)}</button>
      {open && <span className="hint__pop" role="tooltip">{children}</span>}
    </span>
  )
}

/** "+12%" / "−8%" against the period before, or null when there is nothing to compare with. */
function change(now: number, before: number | null): string | null {
  if (before === null || before <= 0) return null
  const d = Math.round(((now - before) / before) * 100)
  return `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)}%`
}

/** The period in six steps, as a little line for a tile: each step is the sum of its days. */
function sparkPath(values: number[]): string | null {
  const steps = Math.min(6, values.length)
  if (steps < 2) return null
  const buckets = Array.from({ length: steps }, (_, i) => sum(values.slice(Math.floor((i * values.length) / steps), Math.floor(((i + 1) * values.length) / steps))))
  const max = Math.max(...buckets)
  if (max <= 0) return null
  return buckets.map((v, i) => `${i ? 'L' : 'M'}${((i * 100) / (steps - 1)).toFixed(1)} ${(37 - (v / max) * 33).toFixed(1)}`).join(' ')
}

/** One headline number: a big value, how it compares with the period before, and the period's shape as a small line. */
function Tile({ label, hint, value, unit, delta, spark, color }: {
  label: string; hint?: ReactNode; value: string; unit?: string; delta: string | null; spark: string | null; color: string
}) {
  return (
    <div className="an-tile">
      <span className="an-tile__l">{label}{hint}</span>
      <span className="an-tile__row">
        <b className="an-tile__v">{value}{unit && <small>{unit}</small>}</b>
        {delta && <span className="an-tile__d"><b>{delta}</b><i> pret iepr.</i></span>}
      </span>
      {spark && <svg className="an-tile__s" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><path d={spark} style={{ stroke: color }} vectorEffect="non-scaling-stroke" /></svg>}
    </div>
  )
}

/** Date labels under a chart: every so many days counted back from today, each under its own day. */
function Axis({ days, compact, inset = 0, insetRight = 0 }: { days: string[]; compact: boolean; inset?: number; insetRight?: number }) {
  const n = days.length
  const step = Math.max(1, Math.ceil(n / (compact ? 3 : 5)))
  return (
    <div className="an-axis" style={{ marginLeft: inset, marginRight: insetRight }}>
      {days.map((d, i) => ((n - 1 - i) % step === 0) && (
        <span key={d} style={i === n - 1 ? { right: 0 } : { left: `${((i + 0.5) / n) * 100}%`, transform: 'translateX(-50%)' }}>{dayLabel(d)}</span>
      ))}
    </div>
  )
}

/**
 * Pages printed per day, one rounded bar per day (a day with nothing printed is a short grey stub). Pointing at
 * a bar, or tapping it, turns it the theme's accent colour and shows its date and count above it.
 */
function Bars({ days, values, compact }: { days: string[]; values: (number | null)[]; compact: boolean }) {
  const [hot, setHot] = useState<number | null>(null)
  const n = days.length
  const max = niceMax(Math.max(1, ...values.map((v) => v ?? 0)))
  const total = sum(values.map((v) => v ?? 0))
  const L = compact ? 26 : 34 // room on the left for the scale's numbers (the same as on the level chart below)
  return (
    <div className="an-block">
      <div className="an-card__head">
        <h3>Izdrukātās lapas dienā</h3>
        <span className={hot === null ? 'an-card__val' : 'an-card__val on'}>
          {hot === null ? <>kopā <b>{fmtNum(total)}</b></> : <><span className="an-card__day">{dayLabel(days[hot])}</span><b>{values[hot] === null ? '–' : fmtNum(values[hot])}</b></>}
        </span>
      </div>
      <div className="an-bars" style={{ paddingLeft: L }} role="img" aria-label={`Izdrukātās lapas dienā: kopā ${total} pēdējās ${n} dienās`}>
        <div className={n > 45 ? 'an-bars__in many' : n > 14 ? 'an-bars__in' : 'an-bars__in few'} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHot(null) }}>
          {/* the scale: 0, half and the top, each a faint line with its number in the left margin */}
          {[0, max / 2, max].map((t) => <span key={t} className="an-bars__tick" style={{ bottom: `${(t / max) * 100}%` }}><b style={{ left: -L }}>{fmtNum(t)}</b></span>)}
          {values.map((v, i) => (
            <div key={days[i]} className={i === hot ? 'an-bar on' : 'an-bar'} onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHot(i) }} onPointerDown={(e) => { if (e.pointerType !== 'mouse') setHot((cur) => (cur === i ? null : i)) }}>
              <i className={v ? '' : 'zero'} style={{ height: v ? `${Math.max(2, (v / max) * 100)}%` : undefined, animationDelay: `${0.25 + (i * 0.6) / n}s` }} />
            </div>
          ))}
          {hot !== null && (
            <span className="an-bars__tip" style={{ left: `clamp(46px, ${((hot + 0.5) / n) * 100}%, calc(100% - 46px))`, bottom: `calc(${((values[hot] ?? 0) / max) * 100}% + 8px)` }}>
              {dayLabel(days[hot])} · {values[hot] === null ? 'nav datu' : fmtNum(values[hot])}
            </span>
          )}
        </div>
      </div>
      <Axis days={days} compact={compact} inset={L} />
    </div>
  )
}

interface Series { key: string; label: string; color: string; ink: string; values: (number | null)[] }

/**
 * Each toner's level (0–100%) day by day, one line per colour, straight through days with no reading (a level
 * doesn't jump about while the printer is off). Pointing at or touching a day shows that day's levels in the
 * heading. Every line starts and ends in a dot, with its level there in a pill of its colour beside it — these
 * stand in for a scale, so the grid lines (0, 50, 100%) carry no numbers.
 */
function Levels({ days, series, compact }: { days: string[]; series: Series[]; compact: boolean }) {
  const [box, w, h] = useSize()
  const [hover, setHover] = useState<number | null>(null)
  // The plot takes whatever height the sheet has left for it (CSS), never less than MIN.
  const MIN = compact ? 64 : 150
  // L, R: room on either side for each line's start and end label
  const H = Math.max(MIN, h), R = compact ? 46 : 54, L = R, T = 8, B = 4
  const n = days.length
  const x = (i: number) => L + (i / (n - 1)) * Math.max(1, w - L - R)
  const y = (v: number) => T + (1 - v / 100) * (H - T - B)
  const known = (values: (number | null)[]) => values.flatMap((v, i) => (v === null ? [] : [i]))
  const line = (values: (number | null)[]) => known(values).map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(values[i]!).toFixed(1)}`).join(' ')
  const latest = (values: (number | null)[]) => values.findLast((v) => v !== null) ?? null
  const at = (clientX: number, el: Element) => {
    const px = clientX - el.getBoundingClientRect().left
    setHover(Math.min(n - 1, Math.max(0, Math.round(((px - L) / Math.max(1, w - L - R)) * (n - 1)))))
  }
  const show = (v: number | null) => (v === null ? '–' : `${v}%`)
  const title = 'Toneru līmeņu % kritums laika gaitā'
  // Start and end labels: each line's first and latest level in a small pill of its colour, beside the dot there.
  // Where lines start or end close together the pills are spread just enough not to overlap (PILL apart),
  // keeping their order.
  const PILL = compact ? 16 : 18
  const labels = (pick: (idx: number[]) => number, min: number) => {
    const list = series.flatMap((s) => { const idx = known(s.values); return idx.length >= min ? [{ s, i: pick(idx), v: s.values[pick(idx)]!, at: y(s.values[pick(idx)]!), spot: 0 }] : [] }).sort((a, b) => a.at - b.at)
    list.forEach((e, k) => { e.spot = k ? Math.max(e.at, list[k - 1].spot + PILL + 1) : e.at })
    for (let k = list.length - 1; k >= 0; k--) list[k].spot = Math.min(list[k].spot, k === list.length - 1 ? H - B - PILL / 2 + 4 : list[k + 1].spot - PILL - 1)
    return list
  }
  const starts = labels((idx) => idx[0], 2), ends = labels((idx) => idx.at(-1)!, 1)
  return (
    <div className="an-block">
      <div className="an-card__head">
        <h3>{title}
          <Hint label={`Kā lasīt: ${title}`}>
            Katras krāsas kasetnes līmenis (0–100%) katras dienas beigās, kā to ziņo printeris.<br />
            <b>Kritums</b> – līnija iet uz leju, kad toneris tiek tērēts; jo stāvāk, jo vairāk izlietots.<br />
            <b>Lēciens uz augšu</b> – kasetne nomainīta pret jaunu.<br />
            <b>Līdzens posms</b> – tajās dienās nav drukāts vai printeris nav bijis sasniedzams.
          </Hint>
        </h3>
        {/* Only while a day is picked: that day's level per colour. (The letter beside each dot names the
            toner, so it is never told apart by colour alone.) */}
        {hover !== null && (
          <span className="an-card__val on">
            <span className="an-card__day">{dayLabel(days[hover])}</span>
            {series.map((s) => <span key={s.key} className="an-card__s" title={s.label}><i style={{ background: s.color }} /><small>{s.key}</small><b>{show(s.values[hover])}</b></span>)}
          </span>
        )}
      </div>
      <div ref={box} className="an-plot" style={{ minHeight: MIN }}>
        {w > 0 && (
          <svg width={w} height={H} role="img" aria-label={`${title}: ${series.map((s) => `${s.label} ${show(latest(s.values))}`).join(', ')}`}
            onPointerMove={(e) => at(e.clientX, e.currentTarget)} onPointerDown={(e) => at(e.clientX, e.currentTarget)} onPointerLeave={() => setHover(null)}>
            {[0, 50, 100].map((t) => (
              <line key={t} x1={L} x2={w - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'an-grid an-grid--base' : 'an-grid'} />
            ))}
            {series.map((s) => known(s.values).length > 0 && (
              <g key={s.key} style={{ color: s.color }}>
                <path d={line(s.values)} pathLength={1} className="an-line" />
                {known(s.values).length === 1 && <circle cx={x(known(s.values)[0])} cy={y(latest(s.values)!)} r="3" fill="currentColor" />}
              </g>
            ))}
            {/* Each line starts and ends in a dot (ringed in the card's colour, so crossing lines stay apart), and
                its level there stands beside it in a pill of the toner's colour: the first on the left, the latest
                on the right. */}
            {[{ list: starts, px: 2, side: 'start' }, { list: ends, px: w - R + 10, side: 'end' }].map(({ list, px, side }) => list.map((e) => (
              <g key={side + e.s.key} className="an-endlab">
                <circle cx={x(e.i)} cy={e.at} r="4" style={{ fill: e.s.color }} className="an-end" />
                <rect x={px} y={e.spot - PILL / 2} width={R - 12} height={PILL} rx={PILL / 2} style={{ fill: e.s.color }} />
                <text x={px + (R - 12) / 2} y={e.spot + 4} textAnchor="middle" style={{ fill: e.s.ink }}>{show(e.v)}</text>
              </g>
            )))}
            {hover !== null && series.some((s) => s.values[hover] !== null) && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={T} y2={y(0)} className="an-cursor" />
                {series.map((s) => s.values[hover] !== null && (
                  <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r="4.5" style={{ fill: s.color }} stroke="var(--card)" strokeWidth="2" />
                ))}
              </g>
            )}
          </svg>
        )}
      </div>
      <Axis days={days} compact={compact} inset={L} insetRight={R} />
    </div>
  )
}

const LIFT = 9 // how far the raised slice of the pie stands above the others (in the pie's own 200-unit square)

/**
 * Each toner's share of everything that was used, as a pie with the share written on each slice. One slice is
 * raised (its top drawn higher, with a darker side under it): the one pointed at or tapped — in the pie or in
 * the table beside it — and otherwise the colour that used the most.
 */
function Pie({ parts }: { parts: { key: string; label: string; color: string; ink: string; value: number }[] }) {
  const [hot, setHot] = useState<string | null>(null)
  const total = sum(parts.map((p) => p.value))
  const live = parts.filter((p) => p.value > 0)
  const share = (v: number) => Math.round((v / total) * 100)
  const up = live.find((p) => p.key === hot)?.key ?? live.reduce<string | null>((best, p) => (best === null || p.value > live.find((q) => q.key === best)!.value ? p.key : best), null)
  const R = 76
  const xy = (deg: number, r: number): [number, number] => { const a = ((deg - 90) * Math.PI) / 180; return [100 + r * Math.cos(a), 100 + r * Math.sin(a)] }
  const slices = live.map((p, i) => {
    const a0 = (sum(live.slice(0, i).map((q) => q.value)) / total) * 360, span = (p.value / total) * 360
    const [sx, sy] = xy(a0, R), [ex, ey] = xy(a0 + span, R)
    const [lx, ly] = live.length === 1 ? [100, 100] : xy(a0 + span / 2, R * 0.62)
    // a whole circle when one colour used everything, a wedge from the middle otherwise
    const d = live.length === 1 ? `M100 ${100 - R} A${R} ${R} 0 1 1 99.99 ${100 - R} Z`
      : `M100 100 L${sx.toFixed(2)} ${sy.toFixed(2)} A${R} ${R} 0 ${span > 180 ? 1 : 0} 1 ${ex.toFixed(2)} ${ey.toFixed(2)} Z`
    return { ...p, d, lx, ly }
  })
  const raised = slices.find((s) => s.key === up) ?? null
  const tap = (key: string) => setHot((cur) => (cur === key ? null : key))
  const over = (key: string) => ({
    onPointerEnter: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') setHot(key) },
    onPointerDown: (e: React.PointerEvent) => { if (e.pointerType !== 'mouse') tap(key) },
  })
  return (
    <section className="an-card an-share">
      <div className="an-card__head">
        <h3>Toneru % patēriņa sadalījums
          <Hint label="Ko nozīmē Relatīvais % un Fakts %">
            <b>Relatīvais %</b> – šīs krāsas daļa no visa periodā izlietotā tonera (visas krāsas kopā ir 100%).<br />
            <b>Fakts %</b> – par cik procentpunktiem periodā saruka šīs krāsas kasetnes līmenis.
          </Hint>
        </h3>
        {total > 0 && <span className="an-card__val">kopā <b>{total}%</b></span>}
      </div>
      {total === 0
        ? <p className="muted an-none">Šajās dienās toneru līmenis nav mainījies.</p>
        : <>
          <div className="an-pie" onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHot(null) }}>
            <div className="an-pie__sq">
              <svg viewBox="0 0 200 200" role="img" aria-label={live.map((p) => `${p.label} ${share(p.value)}%`).join(', ')}>
                <circle cx="100" cy="100" r="99" className="an-pie__halo" />
                <g className="an-pie__body">
                  {slices.map((s) => s.key !== up && <path key={s.key} d={s.d} style={{ fill: s.color }} />)}
                  {raised && (
                    <g key={raised.key} className="an-pie__up">
                      {/* the side: the slice's shape at every step of the way up, in a darker shade of its colour */}
                      {Array.from({ length: LIFT }, (_, k) => <path key={k} d={raised.d} transform={`translate(0 ${-k})`} style={{ fill: `color-mix(in srgb, ${raised.color} 68%, #000)` }} />)}
                      <path d={raised.d} transform={`translate(0 ${-LIFT})`} style={{ fill: raised.color }} />
                    </g>
                  )}
                </g>
                {/* What the pointer and the finger hit: the slices where they lie flat, unseen and on top — so a slice
                    moving up under the pointer can't slip out from under it and start flickering. */}
                {slices.map((s) => <path key={s.key} d={s.d} className="an-pie__hit" {...over(s.key)} />)}
              </svg>
              {slices.map((s) => share(s.value) >= 6 && (
                <span key={s.key} className="an-pie__pct" style={{ left: `${s.lx / 2}%`, top: `${(s.ly - (s.key === up ? LIFT : 0)) / 2}%`, color: s.ink }}>{share(s.value)}%</span>
              ))}
            </div>
          </div>
          {/* Relatīvais % = this colour's share of everything used; Fakts % = how much of its own cartridge went. */}
          <ul className="an-legend" onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHot(null) }}>
            <li className="an-legend__head" aria-hidden="true"><span>Krāsa</span><b>Relatīvais %</b><small>Fakts %</small></li>
            {parts.map((p) => (
              <li key={p.key} className={p.key === up && p.value > 0 ? 'on' : ''} {...over(p.key)}>
                <i style={{ background: p.color }} /><span>{p.label}</span>
                <b aria-label={`relatīvais ${share(p.value)}%`}>{share(p.value)}%</b>
                <small aria-label={`fakts ${p.value}%`}>{p.value ? `−${p.value}%` : '0%'}</small></li>
            ))}
          </ul>
        </>}
    </section>
  )
}

function Charts({ data: all, mono }: { data: Analytics; mono: boolean }) {
  const from = dataStart(all)
  const data: AnalyticsPart = { days: all.days.slice(from), pages: all.pages.slice(from), supplies: all.supplies.map((s) => ({ ...s, pct: s.pct.slice(from) })) }
  const n = data.days.length
  const use = tonerUse(data, mono)
  const perDay = data.days.map((_, i) => sum([...use.values()].map((d) => d[i])))
  const parts = ['K', 'C', 'M', 'Y'].filter((c) => use.has(c)).map((c) => ({ key: c, ...TONERS[c], value: sum(use.get(c)!) }))
  const pages = data.pages.map((v) => v ?? 0)
  const counted = data.pages.filter((v) => v !== null).length
  // Days a toner level could be compared with the day before: the first day that has a reading is only the starting point.
  const tonerDaysOf = (d: AnalyticsPart) => Math.max(0, d.days.filter((_, i) => d.supplies.some((s) => s.pct[i] !== null && classifySupply(s.description, mono)?.kind === 'toner')).length - 1)
  const tonerDays = tonerDaysOf(data)
  const compact = window.matchMedia('(max-width: 800px)').matches
  // Each toner's level at the end of every day (the first supply of a colour, should a printer report two).
  const levels: Series[] = ['K', 'C', 'M', 'Y'].flatMap((c) => {
    const supply = data.supplies.find((s) => { const k = classifySupply(s.description, mono); return k?.kind === 'toner' && k.color === c })
    return supply ? [{ key: c, ...TONERS[c], values: supply.pct }] : []
  })

  // The period before, for "+12% pret iepr." — only when this period is shown whole and the one before is
  // (nearly) complete too: against a few stray days the percentage would be huge and mean nothing.
  const prev = from === 0 ? all.prev : null
  const prevCounted = prev ? prev.pages.filter((v) => v !== null).length : 0
  const prevPages = prev && prevCounted >= 0.8 * n ? sum(prev.pages.map((v) => v ?? 0)) : null
  const prevTonerDays = prev && tonerDaysOf(prev) >= 0.8 * (n - 1) ? tonerDaysOf(prev) : 0
  const prevUse = prev && prevTonerDays ? sum([...tonerUse(prev, mono).values()].flat()) : null
  const pagesAvg = counted ? sum(pages) / counted : 0, tonerAvg = tonerDays ? sum(perDay) / tonerDays : 0
  const tonerHint = (
    <Hint label="Kā skaitīts toneru % patēriņš">
      Visu krāsu kasetņu līmeņa kritums kopā, procentpunktos. Piemēram, melnais −40% un ciāns −15% dod 55%.
      Virs 100% nozīmē, ka kopā izlietots vairāk nekā vienas pilnas kasetnes saturs.
    </Hint>
  )
  return (
    <div className="an">
      <div className="an-tiles">
        <Tile label={`Lapas ${n} dienās`} value={counted ? fmtNum(sum(pages)) : '–'} delta={counted ? change(sum(pages), prevPages) : null} spark={sparkPath(pages)} color="var(--ink)" />
        <Tile label="Lapas vidēji dienā" value={counted ? fmtNum(Math.round(pagesAvg)) : '–'} delta={counted ? change(pagesAvg, prevPages !== null ? prevPages / prevCounted : null) : null} spark={sparkPath(pages)} color="var(--ink)" />
        <Tile label={compact ? `Toneru % ${n} dienās` : `Toneru % patēriņš ${n} dienās`} hint={tonerHint} value={use.size ? String(sum(perDay)) : '–'} unit={use.size ? '%' : ''}
          delta={use.size ? change(sum(perDay), prevUse) : null} spark={use.size ? sparkPath(perDay) : null} color="var(--accent-line)" />
        <Tile label={compact ? 'Toneru % vidēji dienā' : 'Toneru % patēriņš vidēji dienā'} value={tonerDays ? tonerAvg.toLocaleString('lv-LV', { maximumFractionDigits: 1 }) : '–'} unit={tonerDays ? '%' : ''}
          delta={tonerDays ? change(tonerAvg, prevUse !== null ? prevUse / prevTonerDays : null) : null} spark={use.size ? sparkPath(perDay) : null} color="var(--accent-line)" />
      </div>
      <div className="an-cols">
        {/* pages and levels share one panel: two charts, no frame of their own */}
        <section className="an-card an-panel">
          <Bars days={data.days} values={data.pages} compact={compact} />
          {levels.length > 0
            ? <Levels days={data.days} series={levels} compact={compact} />
            : <div className="an-block"><div className="an-card__head"><h3>Toneru līmeņu % kritums laika gaitā</h3></div><p className="muted an-none">Šis printeris pēdējās dienās nav ziņojis toneru līmeni.</p></div>}
        </section>
        {use.size > 0 && <Pie parts={parts} />}
      </div>
      <p className="mhint an-note">Līmenis ir katras dienas pēdējais nolasījums; lēciens uz augšu ir kasetnes nomaiņa. Patēriņš ir līmeņa kritums procentpunktos, nomaiņas diena netiek skaitīta. „Pret iepr.” salīdzina ar tikpat garu periodu pirms šī.</p>
    </div>
  )
}

/**
 * "Analītika": slides up from the bottom (most of the screen; on phones nearly all of it, with everything in
 * view at once). First asks which printer; then shows its last 7, 30 or 90 days — the headline numbers, pages
 * per day, each toner's level day by day, and how the use splits between the colours.
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
  const period = (d: number) => { setError(''); setDays(d) }

  return (
    <>
      <div className="asheet__shade" onClick={onClose} />
      <section className="asheet" role="dialog" aria-modal="true" aria-label="Analītika">
        <header className={printer ? 'asheet__head picked' : 'asheet__head'}>
          {/* With a printer picked its name is the heading and "Analītika" a small label over it. */}
          {printer
            ? <div className="asheet__title">
                <span className="asheet__kicker">{Icon.chart(16)}Analītika<i> · {days} dienas</i></span>
                <h2>{printer.location}</h2>
              </div>
            : <h2 className="asheet__big">{Icon.chart(28)}Analītika</h2>}
          {/* The period: a 7 / 30 / 90 switch on desktop; on phones a stopwatch with the browser's own list behind it. */}
          {printer && <div className="asheet__period"><Segmented label="Periods" value={String(days)} onChange={(v) => period(+v)} options={PERIODS.map((d) => ({ value: String(d), label: `${d} dienas` }))} /></div>}
          {printer && (
            <label className="icon-btn asheet__sel asheet__sel--days" title="Periods">
              {Icon.stopwatch(18)}
              <select value={days} onChange={(e) => period(+e.target.value)} aria-label="Periods">
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
          <button className="icon-btn asheet__close" onClick={onClose} aria-label="Aizvērt">{Icon.close(18)}</button>
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
        {/* The printer's details, and a note when it has less history than the chosen period. */}
        {printer && (
          <div className="asheet__who">
            <span>{[printer.model, printer.company, printer.ip, printer.color_type].filter(Boolean).join(' · ')}</span>
            {fresh && dataStart(loaded!.data) > 0 && <em>dati tikai no {dayLabel(loaded!.data.days[dataStart(loaded!.data)])}</em>}
          </div>
        )}
        {printer && error && <p className="alert">{error}</p>}
        {printer && !error && !fresh && <p className="muted asheet__wait">Ielādē…</p>}
        {printer && !error && fresh && <Charts key={`${printer.id}-${days}`} data={loaded!.data} mono={printer.color_type === 'Melnbalts'} />}
      </section>
    </>
  )
}
