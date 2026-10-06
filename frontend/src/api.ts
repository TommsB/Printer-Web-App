export interface Supply {
  idx: string; description: string; level: number | null; max_capacity: number | null; pct: number | null
  days_left?: number | null // forecast: days until empty at the recent rate of use; null = can't be estimated yet
}
/** Two roles with the same rights in the app; only an admin can manage users (Pārvaldība → Lietotāji). */
export type Role = 'admin' | 'standard'
export interface Session { username: string; role: Role }
/** has_password false = the user can only sign in with Microsoft. */
export interface AppUser { username: string; role: Role; created_ts?: string; created_by?: string | null; has_password?: boolean }
/** Which kinds of push notifications a user wants (see backend/app/push.py). */
export interface PushPrefs { printer: boolean; replacement: boolean; toner: boolean }
export interface PushLogItem { id: number; ts: string; category: keyof PushPrefs; title: string; body: string; url: string }
export interface PushHistory { items: PushLogItem[]; seen: number; unread: number }
export interface PushStatus { public_key: string; prefs: PushPrefs; endpoints: string[] }
export interface Snapshot {
  ts: string; reachable: boolean; hostname: string; serial: string; status: string
  uptime_hours: number | null; page_count: number | null; alerts: string; supplies?: Supply[]
  attention: string // prints, but needs looking at: maintenance requested/overdue (" | "-joined)
  blocking: string // why it can't print (" | "-joined: critical alert, jam, door open, no paper…); '' = it can
  pages_today: number | null // printed since local midnight (or since pages_since if no older reading)
  pages_since: string | null
}
/** How many of a printer's cartridges sit in one storage location. */
export interface StockLoc { location_id: number; name: string; short: string; qty: number }
/** short = "Saīsinājums": optional short display name used where space is tight. */
export interface StoreLocation { id: number; name: string; short: string; active: boolean; sort: number; in_stock: number }
export const UNASSIGNED = 'Nav norādīts'
export interface PrinterToner {
  id: number; code: string; color: string; kind: string; qty: number; optimal_qty: number; low: boolean; ordered: number
  locations: StockLoc[]
}
export interface Printer {
  id: number; company: string; location: string; model: string; brand: string
  ip: string | null // null = not on the network: reserve only, never polled
  color_type: string; snmp_enabled: boolean; active: boolean; notes: string; default_location_id: number | null
  snapshot: Snapshot | null; toners: PrinterToner[]
}
/** One month of a printer's use (newest first from the API). */
export interface UsageMonth {
  month: string // "2026-10"
  pages: number | null // null = no page counter readings that month (e.g. a printer that isn't on the network)
  since: string | null // set in the month the readings began: pages are counted from this day ("2026-10-01")
  toners: { code: string; color: string; qty: number }[] // cartridges marked "Izlietots"
  defects: { code: string; color: string; qty: number }[] // cartridges marked defective that month
}
export interface PrinterInput {
  company: string; location: string; model: string; brand: string; ip: string
  color_type: string; snmp_enabled: boolean; active: boolean; notes: string; toner_ids: number[]
  default_location_id: number | null
  norms: Record<number, number> // toner_id -> norm (optimal stock)
}
export interface Toner { id: number; code: string; color: string; kind: string }
export interface StockRow {
  printer_id: number; company: string; location: string; model: string; ip: string | null
  toner_id: number; code: string; color: string; kind: string; qty: number; optimal_qty: number; low: boolean
  ordered: number // units on open orders
  default_location_id: number | null
  locations: StockLoc[]
}
export interface Order {
  id: number; printer_id: number; toner_id: number; qty: number; status: 'ordered' | 'received' | 'cancelled' | 'defect'
  note: string; created_by: string; created_ts: string; resolved_by: string | null; resolved_ts: string | null
  received_qty: number | null; location: string; model: string; company: string; code: string; color: string; kind: string
  default_location_id: number | null
  /** 1 = warranty claim. It starts as status 'defect' (on the "Defekti" list); "Nodots garantijā" makes it
   *  'ordered' (replacement expected), then received (replacement arrived) or cancelled (rejected). */
  warranty: number
  removed_pct: number | null // toner level when it was taken out, if known
  defect: string
  sent_ts: string | null // when it was handed over for warranty
  sent_by: string | null
  // Defects only:
  pages_printed: number | null // printed while this cartridge was in the printer; null = not known
  installed_ts: string | null // when it was put in (the detected replacement before it)
  held_location_id: number | null // where the defective cartridge is kept until it is handed over
  held_at: string | null // that place's name
  files: number // attached photos / documents
  /** Delivery notes ("pavadzīmes") etc. One document covers several orders, so the same one shows on each.
   *  Only filled in by the order lists. */
  docs?: DeliveryDoc[]
}
export interface DeliveryDoc { id: number; name: string; mime: string; size: number; uploaded_by: string; ts?: string }
export const deliveryDocUrl = (id: number) => `/api/delivery-docs/${id}`
/** A photo or document attached to a defect; opened from /api/order-files/{id}. */
export interface OrderFile { id: number; order_id: number; name: string; mime: string; size: number; uploaded_by: string; ts: string }
export const orderFileUrl = (id: number) => `/api/order-files/${id}`
export interface OrderItem { printer_id: number; toner_id: number; qty: number }
/** Result of "Pārbaudīt savienojumu" in the printer editor (one SNMP read, nothing saved). */
export type SnmpTest =
  | { reachable: false }
  | { reachable: true; hostname: string; description: string; serial: string; page_count: number | null
      supplies: { description: string; pct: number | null }[] }

/** A toner replacement detected from SNMP (level jumped up), waiting for review in Žurnāls. */
export interface TonerEvent {
  id: number; printer_id: number; toner_id: number | null; supply: string; color: string
  from_pct: number; to_pct: number; ts: string; status: 'open' | 'confirmed' | 'dismissed'
  printer_location: string; model: string; toner_code: string | null; qty: number; locations: StockLoc[]
}
export interface Movement {
  id: number; ts: string; delta: number; reason: string; username: string; note: string
  toner_code: string; toner_color: string; printer_location: string | null
  location: string | null; to_location: string | null // storage location(s); to_location only for moves
}

export class UnauthorizedError extends Error {}
let onUnauthorized: () => void = () => {}
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function send(method: string, url: string, body?: unknown): Promise<Response> {
  // A FormData body is a file upload: the browser sets its own multipart Content-Type.
  const upload = body instanceof FormData
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: body === undefined || upload ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : upload ? body : JSON.stringify(body),
  }
  // Reads are safe to repeat: retry a GET up to twice on a network error or 5xx so a brief
  // glitch doesn't leave a page empty. Writes (POST/PUT/DELETE) are never retried.
  const tries = method === 'GET' ? 3 : 1
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, init)
      if (res.status < 500 || i >= tries) return res
    } catch (e) {
      if (i >= tries) throw e
    }
    await sleep(250 * i)
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await send(method, url, body)
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    onUnauthorized()
    throw new UnauthorizedError()
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(typeof data?.detail === 'string' ? data.detail : `Kļūda ${res.status}`)
  }
  if (method !== 'GET' && !url.startsWith('/api/auth/') && !url.startsWith('/api/push/')) for (const fn of changeListeners) fn()
  return res.json()
}

/** Called after every successful change to the data (non-GET; not sign-in or notification settings) —
 *  used to keep the nav counts current. */
const changeListeners = new Set<() => void>()
export function onChange(fn: () => void): () => void {
  changeListeners.add(fn)
  return () => { changeListeners.delete(fn) }
}

export const api = {
  /** What the login page offers: Microsoft sign-in (when configured on the server) and/or the password form. */
  authConfig: () => req<{ microsoft: boolean; password: boolean }>('GET', '/api/auth/config'),
  me: () => req<Session>('GET', '/api/auth/me'),
  login: (username: string, password: string) => req<Session>('POST', '/api/auth/login', { username, password }),
  // User management — the server only allows these for an admin.
  users: () => req<AppUser[]>('GET', '/api/users'),
  createUser: (username: string, password: string, role: Role) => req<AppUser>('POST', '/api/users', { username, password, role }),
  updateUser: (username: string, body: { password?: string; role?: Role }) => req<AppUser>('PUT', `/api/users/${encodeURIComponent(username)}`, body),
  deleteUser: (username: string) => req<unknown>('DELETE', `/api/users/${encodeURIComponent(username)}`),
  logout: () => req<unknown>('POST', '/api/auth/logout'),
  printers: () => req<Printer[]>('GET', '/api/printers'),
  printer: (id: number) => req<Printer>('GET', `/api/printers/${id}`),
  refresh: () => req<{ polled: number }>('POST', '/api/printers/refresh'),
  printerUsage: (id: number) => req<UsageMonth[]>('GET', `/api/printers/${id}/usage`),
  refreshOne: (id: number) => req<{ polled: number }>('POST', `/api/printers/${id}/refresh`),
  createPrinter: (b: PrinterInput) => req<Printer>('POST', '/api/printers', b),
  updatePrinter: (id: number, b: PrinterInput) => req<Printer>('PUT', `/api/printers/${id}`, b),
  deletePrinter: (id: number) => req<unknown>('DELETE', `/api/printers/${id}`),
  toners: () => req<Toner[]>('GET', '/api/toners'),
  createToner: (b: Omit<Toner, 'id'>) => req<Toner>('POST', '/api/toners', b),
  updateToner: (id: number, b: Omit<Toner, 'id'>) => req<Toner>('PUT', `/api/toners/${id}`, b),
  deleteToner: (id: number) => req<unknown>('DELETE', `/api/toners/${id}`),
  stock: () => req<StockRow[]>('GET', '/api/stock'),
  useStock: (printerId: number, tonerId: number, locationId: number, qty = 1) =>
    req<StockRow>('POST', `/api/stock/${printerId}/${tonerId}/use`, { qty, location_id: locationId }),
  moveStock: (printerId: number, tonerId: number, fromId: number, toId: number, qty: number) =>
    req<StockRow>('POST', `/api/stock/${printerId}/${tonerId}/move`, { from_location_id: fromId, to_location_id: toId, qty }),
  correctStock: (printerId: number, tonerId: number, counts: Record<number, number>, reason: string, note: string) =>
    req<StockRow>('POST', `/api/stock/${printerId}/${tonerId}/correct`, { counts, reason, note }),
  locations: () => req<StoreLocation[]>('GET', '/api/locations'),
  events: () => req<TonerEvent[]>('GET', '/api/events?status=open'),
  confirmEvent: (id: number, locationId?: number) =>
    req<TonerEvent>('POST', `/api/events/${id}/confirm`, { location_id: locationId ?? null }),
  dismissEvent: (id: number) => req<TonerEvent>('POST', `/api/events/${id}/dismiss`),
  createLocation: (name: string, short: string) => req<StoreLocation>('POST', '/api/locations', { name, short }),
  updateLocation: (id: number, name: string, short: string, active: boolean) =>
    req<StoreLocation>('PUT', `/api/locations/${id}`, { name, short, active }),
  orders: (status: 'ordered' | 'received' | 'cancelled' | 'defect' | 'all' = 'ordered') => req<Order[]>('GET', `/api/orders?status=${status}`),
  createOrders: (items: OrderItem[], note = '') => req<Order[]>('POST', '/api/orders', { items, note }),
  receiveOrder: (id: number, qty: number, locationId: number) =>
    req<Order>('POST', `/api/orders/${id}/receive`, { qty, location_id: locationId }),
  /** "Nodots garantijā": a cartridge from the Defekti list was handed over; it becomes an open (warranty) order. */
  sendWarranty: (id: number) => req<Order>('POST', `/api/orders/${id}/send`),
  /** Puts one defective cartridge on the "Defekti" list. The reserve doesn't change; nothing is expected yet. */
  createWarranty: (body: {
    printer_id: number; toner_id: number; removed_pct: number | null; defect: string; note?: string
    held_location_id?: number | null; event_id?: number // event_id: the replacement (Jāpārbauda) that took it out
  }) => req<Order>('POST', '/api/orders/warranty', body),
  setHeld: (id: number, locationId: number | null) => req<Order>('PUT', `/api/orders/${id}/held`, { location_id: locationId }),
  orderFiles: (id: number) => req<OrderFile[]>('GET', `/api/orders/${id}/files`),
  /** Attach files to a defect (all or nothing). Returns the record's full file list. */
  uploadOrderFiles: (id: number, files: File[]) => {
    const form = new FormData()
    for (const f of files) form.append('files', f, f.name)
    return req<OrderFile[]>('POST', `/api/orders/${id}/files`, form)
  },
  /** Attach delivery documents to a group of orders; each document then shows on all of them. */
  uploadDeliveryDocs: (orderIds: number[], files: File[]) => {
    const form = new FormData()
    form.append('order_ids', orderIds.join(','))
    for (const f of files) form.append('files', f, f.name)
    return req<DeliveryDoc[]>('POST', '/api/delivery-docs', form)
  },
  /** Removes the document from every order it is linked to. */
  deleteDeliveryDoc: (id: number) => req<unknown>('DELETE', `/api/delivery-docs/${id}`),
  /** Every defect recorded for one printer, newest first. */
  printerDefects: (printerId: number) => req<Order[]>('GET', `/api/orders/defects?printer_id=${printerId}`),
  deleteOrderFile: (fileId: number) => req<unknown>('DELETE', `/api/order-files/${fileId}`),
  /** "Saņemt visus": several open orders at their full quantity, each to its location. All or nothing. */
  receiveOrders: (items: { id: number; location_id: number }[]) => req<Order[]>('POST', '/api/orders/receive-all', { items }),
  cancelOrder: (id: number) => req<Order>('POST', `/api/orders/${id}/cancel`),
  /** Removes the order record only; stock is not changed. */
  deleteOrder: (id: number) => req<unknown>('DELETE', `/api/orders/${id}`),
  setOptimal: (printerId: number, tonerId: number, optimal_qty: number) =>
    req<StockRow>('PUT', `/api/stock/${printerId}/${tonerId}/optimal`, { optimal_qty }),
  movements: () => req<Movement[]>('GET', '/api/movements'),
  deleteMovement: (id: number) => req<unknown>('DELETE', `/api/movements/${id}`),
  // Push notifications (profile window). prefs apply to all of the user's devices; endpoints = their devices.
  push: () => req<PushStatus>('GET', '/api/push'),
  pushSubscribe: (body: { endpoint: string; keys: { p256dh: string; auth: string }; device: string }) => req<unknown>('POST', '/api/push/subscribe', body),
  pushUnsubscribe: (endpoint: string) => req<unknown>('POST', '/api/push/unsubscribe', { endpoint }),
  pushPrefs: (prefs: PushPrefs) => req<PushPrefs>('PUT', '/api/push/prefs', prefs),
  /** The bell button: past notifications (newest first) and how many this user hasn't seen. */
  pushHistory: () => req<PushHistory>('GET', '/api/push/history'),
  pushSeen: (id: number) => req<{ seen: number }>('POST', '/api/push/seen', { id }),
  pushTest: (endpoint: string) => req<{ ok: boolean; status: number; reason?: string; contact?: string }>('POST', '/api/push/test', { endpoint }),
  /** Per-user settings (key → text); null = not set yet. */
  getSetting: (key: string) => req<{ value: string | null }>('GET', `/api/settings/${key}`),
  putSetting: (key: string, value: string) => req<{ value: string }>('PUT', `/api/settings/${key}`, { value }),
  testSnmp: (ip: string) => req<SnmpTest>('POST', '/api/printers/test-snmp', { ip }),
  /** Save the user's custom printer order (Statuss and Krājumi follow it; /api/printers returns printers in it). */
  setOrder: (ids: number[]) => req<{ ids: number[] }>('PUT', '/api/printers/order', { ids }),
}

// Server times are local wall-clock strings ("2026-10-02T14:05:00[.ffffff]", no timezone).
const DATE_TIME = new Intl.DateTimeFormat('lv-LV', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const CLOCK = new Intl.DateTimeFormat('lv-LV', { hour: '2-digit', minute: '2-digit' })

/** Parses a server time as local time (seconds precision; Safari rejects long fractions). */
export function parseTs(ts: string): Date | null {
  const d = new Date(ts.replace(' ', 'T').slice(0, 19))
  return Number.isNaN(d.getTime()) ? null : d
}

/** "02.10.2026. 14:05" */
export function fmtTime(ts: string): string {
  const d = parseTs(ts)
  return d ? DATE_TIME.format(d) : ts.replace('T', ' ').slice(0, 16)
}

/** "14:05" */
export function fmtClock(ts: string): string {
  const d = parseTs(ts)
  return d ? CLOCK.format(d) : ts.slice(11, 16)
}
