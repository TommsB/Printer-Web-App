import type { Order, Printer, Role, StockRow, Supply } from './api'

export type Col = 'k' | 'c' | 'm' | 'y'
export interface TonerLevel { col: Col; name: string; pct: number | null; days: number | null }

/** Forecast at or below this many days is shown as urgent (same limit as the notification, push.py SOON_DAYS). */
export const SOON_DAYS = 14
/** "≈ 12 d." next to a toner level; far-off forecasts are capped, they aren't that precise. */
export const fmtDaysLeft = (d: number) => (d <= 0 ? 'beidzas' : d > 90 ? '> 90 d.' : `≈ ${d} d.`)

/** How many cartridges are missing to the norm: norm minus stock minus what is already on order for it
 *  (extras ordered from the basket are on top of the norm, so they don't count). */
export const missing = (r: { qty: number; optimal_qty: number; ordered: number; ordered_extra?: number }) =>
  Math.max(0, r.optimal_qty - r.qty - (r.ordered - (r.ordered_extra ?? 0)))
/** "Jāpasūta vienības": the big number in Krājumi and the count on its nav tab. */
export const needUnits = (rows: StockRow[], company: string) =>
  rows.reduce((n, r) => (!company || r.company === company ? n + missing(r) : n), 0)

const COLORS: [string, Col, string][] = [
  ['black', 'k', 'Black'], ['cyan', 'c', 'Cyan'], ['magenta', 'm', 'Magenta'], ['yellow', 'y', 'Yellow'],
]
const NOT_TONER = /drum|developer|imag|transfer|waste|fus|kit|unit|belt|roller/i
export const LOW_PCT = 15

function colorOf(desc: string): [Col, string] | null {
  const d = desc.toLowerCase()
  for (const [word, col, name] of COLORS) if (d.includes(word)) return [col, name]
  // Kyocera names cartridges by code only, e.g. "CK-8511C": the last letter is the colour.
  const m = /^[a-z]{1,3}-?\d{3,5}([cmyk])$/i.exec(desc.trim())
  if (m) {
    const col = m[1].toLowerCase() as Col
    return [col, COLORS.find((c) => c[1] === col)![2]]
  }
  return null
}

/** Splits SNMP supplies into per-colour toner levels (K,C,M,Y order) and everything else. */
export function splitSupplies(p: Printer): { toners: TonerLevel[]; others: Supply[] } {
  const supplies = p.snapshot?.reachable ? p.snapshot.supplies ?? [] : []
  const toners: TonerLevel[] = []
  const used = new Set<string>()
  for (const s of supplies) {
    const c = colorOf(s.description)
    if (!c || NOT_TONER.test(s.description)) continue
    toners.push({ col: c[0], name: c[1], pct: s.pct, days: s.days_left ?? null })
    used.add(s.idx)
  }
  if (toners.length === 0 && p.color_type === 'Melnbalts') {
    const s = supplies.find((x) => /toner|cartridge/i.test(x.description) && !NOT_TONER.test(x.description))
    if (s) { toners.push({ col: 'k', name: 'Black', pct: s.pct, days: s.days_left ?? null }); used.add(s.idx) }
  }
  toners.sort((a, b) => 'kcmy'.indexOf(a.col) - 'kcmy'.indexOf(b.col))
  return { toners, others: supplies.filter((s) => !used.has(s.idx) && s.pct !== null) }
}

const STATUS_LV: Record<string, string> = {
  idle: 'Gatavs', printing: 'Drukā', warmup: 'Iesilst', other: 'Gatavs', unknown: 'Gatavs',
}

// Printer alerts that are just informational (power saving etc.) and shouldn't be highlighted.
const BENIGN_ALERT = /sleep|power ?sav|low power|energy|ready|warming|warm-?up|idle|calibrat|cleaning/i

/** An alert worth highlighting: anything not in the harmless list (toner, jams, empty trays, doors, errors…). */
export function isImportantAlert(text: string): boolean {
  return text.trim() !== '' && !BENIGN_ALERT.test(text)
}

/** hot = needs attention (orange dot); lineHot = status text shown in red (unreachable, or can't print).
 *  blocked = reasons it can't print right now (critical alert / jam / door open / no paper…), from SNMP. */
export interface PrinterState { offline: boolean; noData: boolean; hot: boolean; lineHot: boolean; line: string; tag: string; blocked: string[] }

export function printerState(p: Printer): PrinterState {
  const snap = p.snapshot
  if (!p.ip) return { offline: false, noData: true, hot: false, lineHot: false, line: 'Nav tīklā', tag: 'Nav tīklā', blocked: [] }
  if (!p.snmp_enabled) return { offline: false, noData: true, hot: false, lineHot: false, line: 'SNMP izslēgts', tag: 'SNMP izslēgts', blocked: [] }
  if (!snap) return { offline: false, noData: true, hot: false, lineHot: false, line: 'Nav datu', tag: 'Nav datu', blocked: [] }
  if (!snap.reachable) return { offline: true, noData: false, hot: true, lineHot: true, line: 'Nav pieejams', tag: 'Nav pieejams', blocked: [] }
  const blocked = (snap.blocking ?? '').split(' | ').filter(Boolean)
  if (blocked.length) return { offline: false, noData: false, hot: true, lineHot: true, line: blocked.join(', '), tag: 'Nevar drukāt', blocked }
  const alert = snap.alerts.split(' | ')[0]
  const lowToner = splitSupplies(p).toners.some((t) => t.pct !== null && t.pct < LOW_PCT)
  const hot = snap.alerts.split(' | ').some(isImportantAlert) || lowToner || p.toners.some((t) => t.low)
  const base = STATUS_LV[snap.status] ?? 'Gatavs'
  return { offline: false, noData: false, hot, lineHot: false, line: alert || base, tag: hot ? 'Uzmanību' : base, blocked: [] }
}

/** Where a defect (warranty claim) stands, by its order status; `cls` colours its icon. */
export const DEFECT_STATUS: Record<Order['status'], { label: string; cls: string }> = {
  planned: { label: 'Grozā', cls: 'k-fix' }, // never a defect; here only to cover every order status
  defect: { label: 'Nav nodots', cls: 'k-out' },
  ordered: { label: 'Nodots garantijā', cls: 'k-wait' },
  received: { label: 'Aizvietots', cls: 'k-in' },
  cancelled: { label: 'Noraidīts', cls: 'k-fix' },
}

const DATE = new Intl.DateTimeFormat('lv-LV', { day: '2-digit', month: '2-digit', year: 'numeric' })
/** "06.10.2026." from a server time. */
export function fmtDate(ts: string): string {
  const d = new Date(ts.replace(' ', 'T').slice(0, 19))
  return Number.isNaN(d.getTime()) ? ts.slice(0, 10) : DATE.format(d)
}

/** autoFocus only with a mouse/trackpad: on phones it would pop the keyboard over the form. */
export const canAutoFocus = () => window.matchMedia('(pointer: fine)').matches

/** Role names as shown in the app (Pārvaldība → Lietotāji, the profile window). */
export const ROLE_LV: Record<Role, string> = { admin: 'Administrators', standard: 'Standarta lietotājs' }

const DAY = new Intl.DateTimeFormat('lv-LV', { weekday: 'long', day: '2-digit', month: '2-digit' })
const DAY_YEAR = new Intl.DateTimeFormat('lv-LV', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Day heading in Vēsture for a "YYYY-MM-DD" day: "Šodien", "Vakar", or "pirmdiena, 28.09." (+ year if not this year). */
export function dayLabel(day: string): string {
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (day === localDay(now)) return 'Šodien'
  if (day === localDay(yesterday)) return 'Vakar'
  const [y, m, d] = day.split('-').map(Number)
  return (y === now.getFullYear() ? DAY : DAY_YEAR).format(new Date(y, m - 1, d))
}

/**
 * "Needs attention" (the dot in the printer list): still prints, but someone should look —
 * maintenance requested/overdue (from SNMP) or spare cartridges below the norm. Low toner doesn't count
 * (levels are shown on their own); can't-print / offline have their own badge, so no dot then.
 */
export function attentionReasons(p: Printer): string[] {
  const st = printerState(p)
  const out = st.offline || st.blocked.length ? [] : (p.snapshot?.attention ?? '').split(' | ').filter(Boolean)
  const qty = p.toners.reduce((n, t) => n + t.qty, 0)
  const norm = p.toners.reduce((n, t) => n + t.optimal_qty, 0)
  if (p.toners.some((t) => t.qty < t.optimal_qty)) out.push(`Rezerve zem normas (${qty}/${norm})`)
  return out
}

export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined ? '–' : n.toLocaleString('lv-LV'))
export const fmtHours = (n: number | null | undefined) => (n === null || n === undefined ? '–' : n.toFixed(1))
