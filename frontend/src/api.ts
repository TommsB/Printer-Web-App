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
/** Notification hours: when on, the user is only told between start and end ("HH:MM") on these weekdays
 *  (0 = Monday). What comes up outside waits and is delivered when the hours start, if it still applies. */
export interface PushSchedule { enabled: boolean; start: string; end: string; days: number[] }
/** `schedules`: each of the user's devices (by endpoint) with notifications on → that device's notification hours. */
export interface PushStatus { public_key: string; prefs: PushPrefs; endpoints: string[]; schedules: Record<string, PushSchedule> }
export interface Snapshot {
  ts: string; reachable: boolean; hostname: string; serial: string; status: string
  uptime_hours: number | null; page_count: number | null; alerts: string; supplies?: Supply[]
  attention: string // prints, but needs looking at: maintenance requested/overdue (" | "-joined)
  blocking: string // why it can't print (" | "-joined: critical alert, jam, door open, no paper…); '' = it can
  pages_today: number | null // printed since local midnight (or since pages_since if no older reading)
  pages_since: string | null
  offline_since: string | null // not answering: since this reading (the first failed one after the last that answered)
  offline_long: boolean // …and no reading still kept answered, so it has been longer than that
  asleep: boolean // not answering because it is asleep ("Printeris var aizmigt", before its wake check): grey, not red
}
/** How many of a printer's cartridges sit in one storage location. */
export interface StockLoc { location_id: number; name: string; short: string; qty: number }
/** short = "Saīsinājums": optional short display name used where space is tight. */
export interface StoreLocation {
  id: number; name: string; short: string; active: boolean; sort: number; in_stock: number
  is_global: boolean // "Globāla noliktava": offered first as a place to move to, for every printer
}
export const UNASSIGNED = 'Nav norādīts'
export interface PrinterToner {
  id: number; code: string; color: string; kind: string; qty: number; optimal_qty: number; low: boolean; ordered: number
  ordered_extra: number // of `ordered`: extras from the basket, which don't count towards the norm
  locations: StockLoc[]
}
export interface Printer {
  id: number; company: string; location: string; model: string; brand: string
  ip: string | null // null = not on the network: reserve only, never polled
  color_type: string; snmp_enabled: boolean; snmp_version: SnmpVersion; active: boolean; notes: string; default_location_id: number | null
  can_sleep: boolean // "Printeris var aizmigt": not answering is sleep, not offline (backend sleep.py)
  empties_location_id: number | null // where this printer's empty cartridges go by default (Tukšie)
  main_location_id: number | null // where its toners are kept: a move goes there by default
  photo: string | null // its picture's file name (backend photos.py); null = the printer icon shows
  snapshot: Snapshot | null; toners: PrinterToner[]
}
/** Address of a printer's picture. It carries the file name, so a new picture is a new address (cached for good). */
export const photoUrl = (p: Pick<Printer, 'id' | 'photo'>) => (p.photo ? `/api/printers/${p.id}/photo?v=${encodeURIComponent(p.photo)}` : null)
/** One month of a printer's use (newest first from the API). */
/** The chosen period (7, 30 or 90 days) for the "Analītika" charts: pages printed per day, and each reported supply's level at the end of each day. */
export interface AnalyticsPart { days: string[]; pages: (number | null)[]; supplies: { idx: string; description: string; pct: (number | null)[] }[] }
/** `prev` = the same for the period just before (as many days again), for the "pret iepr." comparison. */
export interface Analytics extends AnalyticsPart { prev: AnalyticsPart }
/** Every active printer's Analytics for the same period: the "Visi printeri" view adds them up. */
export interface AllAnalytics { printers: ({ id: number } & Analytics)[] }
export interface UsageMonth {
  month: string // "2026-10"
  pages: number | null // null = no page counter readings that month (e.g. a printer that isn't on the network)
  since: string | null // set in the month the readings began: pages are counted from this day ("2026-10-01")
  toners: { code: string; color: string; kind: string; qty: number }[] // cartridges marked "Izlietots"
  defects: { code: string; color: string; kind: string; qty: number }[] // cartridges marked defective that month
}
export interface PrinterInput {
  company: string; location: string; model: string; brand: string; ip: string
  color_type: string; snmp_enabled: boolean; snmp_version: SnmpVersion; can_sleep: boolean; active: boolean; notes: string; toner_ids: number[]
  default_location_id: number | null
  empties_location_id: number | null
  main_location_id: number | null
  norms: Record<number, number> // toner_id -> norm (optimal stock)
}
export interface Toner { id: number; code: string; color: string; kind: string; price: number | null } // price: € per cartridge, null = not known
export type TonerInput = Omit<Toner, 'id' | 'price'> & { price?: number | null }

/** Actual spending in one period (a month, this year, the last 90 days): received orders at their kept price.
 *  estimated = cartridges priced at today's component price (orders from before prices were kept); unpriced = no
 *  price at all (counted 0 €). toners / drums: of qty, how many were each (the rest is other components).
 *  by_printer: { printer id: [cost, cartridges, estimated, unpriced, toners, drums] }. */
export interface SpendBucket {
  cost: number; qty: number; toners: number; drums: number; estimated: number; unpriced: number
  by_company: Record<string, number>; by_printer: Record<string, [number, number, number, number, number, number]>
}
/** One supply's share of a printer's running cost over the period. */
export interface CostSupply {
  toner_id: number; code: string; kind: string; color: string; price: number | null
  // level/runs_out_days null and current false: the slot isn't reported any more (renamed or removed in the period)
  used_pct: number; pct_per_day: number; level: number | null; runs_out_days: number | null; current: boolean; cost: number | null
  own_days: number // days of readings behind this slot's pace (none under a week: pct_per_day 0)
  // From the pace (null without one): a cartridge lasts life_days, that's per_year replacements a year, and it
  // costs per_month (price × % a day ÷ 100 × 30.44; null without a price). The printer's per_month is their sum.
  life_days: number | null; per_year: number | null; per_month: number | null
}
/** A printer's running cost. method: 'levels' = from its daily toner/drum levels; 'taken' = from cartridges taken
 *  from its reserve (no level readings); null = nothing to go on. Sums are null when none of its codes has a price. */
export interface PrinterCost {
  id: number; location: string; company: string; model: string; method: 'levels' | 'taken' | null
  per_month: number | null; per_year: number | null; cost_per_page: number | null; pages_per_month: number | null
  span_days: number | null; supplies: CostSupply[]; missing: string[]; unpriced: string[]
}
/** Analītika → Izmaksas (backend costs.py): the forecast, and what was really spent (received orders by delivery date). */
export interface CostSummary {
  days: number; per_month: number; per_year: number; cost_per_page: number | null
  by_company: Record<string, number>
  unpriced: string[]
  // months: the last 12 calendar months, oldest first; year: this year so far; recent: the last recent_days days
  actual: { months: (SpendBucket & { month: string })[]; year: SpendBucket; recent: SpendBucket; recent_days: number }
  printers: PrinterCost[]
}
export interface StockRow {
  printer_id: number; company: string; location: string; model: string; ip: string | null
  toner_id: number; code: string; color: string; kind: string; qty: number; optimal_qty: number; low: boolean
  ordered: number // units on open orders
  ordered_extra: number // of those: extras from the basket, which don't count towards the norm
  active: boolean // false = the printer is switched off in Pārvaldība (its reserve is still kept)
  empties_location_id: number | null // the printer's default place for empty cartridges
  default_location_id: number | null
  main_location_id: number | null // the printer's main storage place (default target of a move)
  locations: StockLoc[]
}
export interface Order {
  id: number; printer_id: number; toner_id: number; qty: number; status: 'planned' | 'ordered' | 'received' | 'cancelled' | 'defect' // planned = in the basket (Grozs), not ordered yet
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
  unit_price: number | null // € per cartridge paid: the component's price when ordered, editable (null = not kept)
  current_price: number | null // the component's price now (shown for orders without a kept price)
  /** Delivery notes ("pavadzīmes") etc. One document covers several orders, so the same one shows on each.
   *  Only filled in by the order lists. */
  docs?: DeliveryDoc[]
}
export interface DeliveryDoc { id: number; name: string; mime: string; size: number; uploaded_by: string; ts?: string }
export const deliveryDocUrl = (id: number) => `/api/delivery-docs/${id}`
/** A photo or document attached to a defect; opened from /api/order-files/{id}. */
export interface OrderFile { id: number; order_id: number; name: string; mime: string; size: number; uploaded_by: string; ts: string }
export const orderFileUrl = (id: number) => `/api/order-files/${id}`
/** Empty cartridges are counted per place and kind only (not per code). */
export type EmptyKind = 'toner' | 'drum'
export interface EmptyRow { location_id: number; location: string; kind: EmptyKind; qty: number }
export interface EmptyLogItem {
  id: number; ts: string; username: string; kind: EmptyKind; delta: number
  reason: 'used' | 'returned' | 'moved' | 'correction'; note: string; location: string | null; to_location: string | null
}
export interface Empties { rows: EmptyRow[]; log: EmptyLogItem[] }
/** A stock action that can be taken back for a few minutes: the id of the history entry it wrote. */
export interface Undoable { movement_id: number }
export interface OrderItem { printer_id: number; toner_id: number; qty: number }
/** Result of "Pārbaudīt savienojumu" in the printer editor (one SNMP read, nothing saved). */
/** '1' for a printer without SNMP v2c. */
export type SnmpVersion = '2c' | '1'
/** version: the one that answered (the chosen one is tried first, then the other). */
export type SnmpTest =
  | { reachable: false }
  | { reachable: true; version: SnmpVersion; hostname: string; description: string; serial: string; page_count: number | null
      supplies: { description: string; pct: number | null }[] }

/** A toner or drum replacement detected from SNMP (level jumped up), waiting for review in Žurnāls.
 *  kind: what was replaced; color is '' for a drum the printer reports without a colour. */
export interface TonerEvent {
  id: number; printer_id: number; toner_id: number | null; supply: string; color: string; kind: 'toner' | 'drum'
  from_pct: number; to_pct: number; ts: string; status: 'open' | 'confirmed' | 'dismissed'
  printer_location: string; model: string; toner_code: string | null; qty: number; locations: StockLoc[]
  empties_location_id: number | null // the printer's default place for empty cartridges
}
export interface Movement {
  id: number; ts: string; delta: number; reason: string; username: string; note: string
  toner_code: string; toner_color: string; toner_kind: string; printer_location: string | null
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
  printerAnalytics: (id: number, days: number) => req<Analytics>('GET', `/api/printers/${id}/analytics?days=${days}`),
  allAnalytics: (days: number) => req<AllAnalytics>('GET', `/api/printers/analytics/all?days=${days}`),
  refreshOne: (id: number) => req<{ polled: number }>('POST', `/api/printers/${id}/refresh`),
  createPrinter: (b: PrinterInput) => req<Printer>('POST', '/api/printers', b),
  updatePrinter: (id: number, b: PrinterInput) => req<Printer>('PUT', `/api/printers/${id}`, b),
  deletePrinter: (id: number) => req<unknown>('DELETE', `/api/printers/${id}`),
  /** Set or replace a printer's picture (already cropped and shrunk: see photo.ts). */
  setPrinterPhoto: (id: number, image: Blob) => {
    const form = new FormData()
    form.append('file', image, 'printeris.jpg')
    return req<{ photo: string }>('PUT', `/api/printers/${id}/photo`, form)
  },
  deletePrinterPhoto: (id: number) => req<{ photo: null }>('DELETE', `/api/printers/${id}/photo`),
  toners: () => req<Toner[]>('GET', '/api/toners'),
  createToner: (b: TonerInput) => req<Toner>('POST', '/api/toners', b),
  updateToner: (id: number, b: TonerInput) => req<Toner>('PUT', `/api/toners/${id}`, b),
  /** The cost forecast for every active printer; `days`: the period the pace is taken from (30 or 90). */
  costs: (days: number) => req<CostSummary>('GET', `/api/costs?days=${days}`),
  deleteToner: (id: number) => req<unknown>('DELETE', `/api/toners/${id}`),
  stock: () => req<StockRow[]>('GET', '/api/stock'),
  /** emptyLocationId: where the empty cartridge is put (Tukšie); null = it isn't counted. */
  useStock: (printerId: number, tonerId: number, locationId: number, qty = 1, emptyLocationId: number | null = null) =>
    req<StockRow & Undoable>('POST', `/api/stock/${printerId}/${tonerId}/use`, { qty, location_id: locationId, empty_location_id: emptyLocationId }),
  moveStock: (printerId: number, tonerId: number, fromId: number, toId: number, qty: number) =>
    req<StockRow>('POST', `/api/stock/${printerId}/${tonerId}/move`, { from_location_id: fromId, to_location_id: toId, qty }),
  correctStock: (printerId: number, tonerId: number, counts: Record<number, number>, reason: string, note: string) =>
    req<StockRow>('POST', `/api/stock/${printerId}/${tonerId}/correct`, { counts, reason, note }),
  locations: () => req<StoreLocation[]>('GET', '/api/locations'),
  events: () => req<TonerEvent[]>('GET', '/api/events?status=open'),
  confirmEvent: (id: number, locationId?: number, emptyLocationId: number | null = null) =>
    req<TonerEvent>('POST', `/api/events/${id}/confirm`, { location_id: locationId ?? null, empty_location_id: emptyLocationId }),
  dismissEvent: (id: number) => req<TonerEvent>('POST', `/api/events/${id}/dismiss`),
  createLocation: (name: string, short: string, is_global: boolean) => req<StoreLocation>('POST', '/api/locations', { name, short, is_global }),
  updateLocation: (id: number, name: string, short: string, active: boolean, is_global: boolean) =>
    req<StoreLocation>('PUT', `/api/locations/${id}`, { name, short, active, is_global }),
  orders: (status: Order['status'] | 'all' = 'ordered') => req<Order[]>('GET', `/api/orders?status=${status}`),
  /** Places an order. `extra` = it is the basket's "papildus" part for those toners: that part is used up and
   *  the order doesn't count towards the norm. Without it: the part missing to the norm. */
  createOrders: (items: OrderItem[], note = '', extra = false) => req<Order[]>('POST', '/api/orders', { items, note, extra }),
  /** Puts extra cartridges in the basket ("Grozs"), on top of what is missing to the norm. Nothing is ordered. */
  addToBasket: (items: OrderItem[], note = '') => req<Order[]>('POST', '/api/orders', { items, note, planned: true }),
  receiveOrder: (id: number, qty: number, locationId: number) =>
    req<Order & Undoable>('POST', `/api/orders/${id}/receive`, { qty, location_id: locationId }),
  /** How many of a toner are in the basket by hand (only basket entries can be changed). */
  setBasketQty: (id: number, qty: number) => req<Order>('PUT', `/api/orders/${id}/qty`, { qty }),
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
  receiveOrders: (items: { id: number; location_id: number }[]) => req<(Order & Undoable)[]>('POST', '/api/orders/receive-all', { items }),
  cancelOrder: (id: number) => req<Order>('POST', `/api/orders/${id}/cancel`),
  /** Removes the order record only; stock is not changed. */
  deleteOrder: (id: number) => req<unknown>('DELETE', `/api/orders/${id}`),
  /** Correct what was paid per cartridge (0 for a free one). Not for warranty replacements. */
  setOrderPrice: (id: number, unitPrice: number) => req<Order & { docs: DeliveryDoc[] }>('PUT', `/api/orders/${id}/price`, { unit_price: unitPrice }),
  setOptimal: (printerId: number, tonerId: number, optimal_qty: number) =>
    req<StockRow>('PUT', `/api/stock/${printerId}/${tonerId}/optimal`, { optimal_qty }),
  movements: () => req<Movement[]>('GET', '/api/movements'),
  // Tukšie: empty cartridges per storage place and kind, until they are handed back to the supplier.
  empties: () => req<Empties>('GET', '/api/empties'),
  returnEmpties: (b: { location_id: number; kind: EmptyKind; qty: number; note?: string }) => req<Empties>('POST', '/api/empties/return', b),
  moveEmpties: (b: { from_location_id: number; to_location_id: number; kind: EmptyKind; qty: number }) => req<Empties>('POST', '/api/empties/move', b),
  correctEmpties: (b: { location_id: number; kind: EmptyKind; qty: number; note?: string }) => req<Empties>('POST', '/api/empties/correct', b),
  deleteMovement: (id: number) => req<unknown>('DELETE', `/api/movements/${id}`),
  /** "Atsaukt" right after Izlietots / Saņemt: restores the reserve, removes the history entries, reopens the order. */
  undoMovements: (ids: number[]) => req<{ undone: number }>('POST', '/api/movements/undo', { ids }),
  // Push notifications (profile window). prefs apply to all of the user's devices; endpoints = their devices.
  push: () => req<PushStatus>('GET', '/api/push'),
  pushSubscribe: (body: { endpoint: string; keys: { p256dh: string; auth: string }; device: string }) => req<unknown>('POST', '/api/push/subscribe', body),
  pushUnsubscribe: (endpoint: string) => req<unknown>('POST', '/api/push/unsubscribe', { endpoint }),
  pushPrefs: (prefs: PushPrefs) => req<PushPrefs>('PUT', '/api/push/prefs', prefs),
  /** The bell button: past notifications (newest first) and how many this user hasn't seen. */
  pushHistory: () => req<PushHistory>('GET', '/api/push/history'),
  pushSeen: (id: number) => req<{ seen: number }>('POST', '/api/push/seen', { id }),
  /** Remove one entry / all entries from this user's own list (other users keep theirs). */
  pushDelete: (id: number) => req<unknown>('DELETE', `/api/push/history/${id}`),
  pushClear: () => req<unknown>('DELETE', '/api/push/history'),
  pushSchedule: (endpoint: string, schedule: PushSchedule) => req<PushSchedule>('PUT', '/api/push/schedule', { endpoint, ...schedule }),
  pushTest: (endpoint: string) => req<{ ok: boolean; status: number; reason?: string; contact?: string }>('POST', '/api/push/test', { endpoint }),
  /** Per-user settings (key → text); null = not set yet. */
  getSetting: (key: string) => req<{ value: string | null }>('GET', `/api/settings/${key}`),
  putSetting: (key: string, value: string) => req<{ value: string }>('PUT', `/api/settings/${key}`, { value }),
  testSnmp: (ip: string, version: SnmpVersion) => req<SnmpTest>('POST', '/api/printers/test-snmp', { ip, version }),
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
