import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from './api'

/**
 * Stale-while-revalidate for page data: a page shows the last loaded copy instantly (no blank flash
 * when switching pages) and refreshes it in the background. Lives in memory for this browser tab.
 */
const cache = new Map<string, unknown>()
const inflight = new Map<string, Promise<unknown>>()

// Readers of the cache itself (useCached: the nav counts) are told when a copy changes. Deferred, because a
// copy can be replaced inside a state updater, where notifying another component at once isn't allowed.
const watchers = new Set<() => void>()
const changed = () => queueMicrotask(() => { for (const w of watchers) w() })
const watch = (w: () => void) => { watchers.add(w); return () => { watchers.delete(w) } }

/** The cached copy of `key`, kept current whoever reloads it. Does not fetch. `fallback` must be a constant. */
export function useCached<T>(key: string, fallback: T): T {
  return useSyncExternalStore(watch, () => (cache.has(key) ? (cache.get(key) as T) : fallback))
}

// key -> how to reload it, for the data that is on screen right now (registered by useApiData).
const onScreen = new Map<string, Set<() => void>>()

/** Reload everything that is on screen (after a change made outside the page that shows it, e.g. "Atsaukt").
 *  One request per key; every component showing that key follows through the cache. */
export function refreshAll(): void {
  for (const reloads of onScreen.values()) {
    const [first] = reloads
    first?.()
  }
}

/** Reload `key` in the background (joins a request already running). */
export function refresh<T>(key: string, fetcher: () => Promise<T>): void {
  load(key, fetcher, true).catch(() => {})
}

/**
 * Fetch `key` and store it in the cache. With `shared`, a request already in flight for the same key is
 * reused (e.g. the login prefetch and a page opening at the same moment → one request, not two).
 * Without it (explicit reloads after a change), a fresh request always starts so it can't return pre-change data.
 */
function load<T>(key: string, fn: () => Promise<T>, shared: boolean): Promise<T> {
  const running = inflight.get(key)
  if (shared && running) return running as Promise<T>
  const p = fn()
    .then((v) => { if (inflight.get(key) === p) { cache.set(key, v); changed() } return v })
    .finally(() => { if (inflight.get(key) === p) inflight.delete(key) })
  inflight.set(key, p)
  return p
}

export function useApiData<T>(key: string, fetcher: () => Promise<T>, fallback: T) {
  const [data, setState] = useState<T>(() => (cache.has(key) ? (cache.get(key) as T) : fallback))
  const [loading, setLoading] = useState(!cache.has(key))
  const fetchRef = useRef(fetcher)
  useLayoutEffect(() => { fetchRef.current = fetcher })

  const run = useCallback(async (shared: boolean) => {
    try {
      const v = await load(key, () => fetchRef.current(), shared)
      setState(v)
      return v
    } finally {
      setLoading(false)
    }
  }, [key])

  /** Fresh load (use after changing something). */
  const reload = useCallback(() => run(false), [run])

  /** Local update (e.g. optimistic pin) that also keeps the cached copy in sync. */
  const setData = useCallback((next: T | ((prev: T) => T)) => {
    setState((prev) => {
      const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
      cache.set(key, v)
      changed()
      return v
    })
  }, [key])

  // On open: reuse a request already in flight for this key (prefetch or another page) instead of a duplicate.
  useEffect(() => { run(true).catch(() => {}) }, [run])

  // Follow the cache: when someone else reloads this key (another component, refreshAll), show it here too.
  useEffect(() => watch(() => { if (cache.has(key)) setState(cache.get(key) as T) }), [key])
  // While on screen, this data can be reloaded from outside (refreshAll).
  useEffect(() => {
    const again = () => { load(key, () => fetchRef.current(), false).catch(() => {}) }
    const set = onScreen.get(key) ?? new Set()
    onScreen.set(key, set.add(again))
    return () => { set.delete(again) }
  }, [key])

  return { data, loading, reload, setData }
}

/** Warm the cache for every page right after login, so even the first visit to a page is instant. */
export function prefetchAll(): void {
  const jobs: [string, () => Promise<unknown>][] = [
    ['printers', api.printers],
    ['stock', api.stock],
    ['orders', () => api.orders('ordered')],
    ['defects', () => api.orders('defect')],
    ['basket', () => api.orders('planned')],
    ['toners', api.toners],
    ['movements', api.movements],
    ['locations', api.locations],
  ]
  for (const [key, fn] of jobs) load(key, fn, true).catch(() => {})
}

/** Drop cached copies that a change made elsewhere has outdated, so those pages load fresh instead of flashing old data. */
export function invalidate(...keys: string[]): void {
  for (const k of keys) { cache.delete(k); inflight.delete(k) }
  changed()
}

/** Forget everything (on logout, so the next user never sees the previous user's data). */
export function clearCache(): void {
  cache.clear()
  inflight.clear()
  changed()
}
