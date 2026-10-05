import { useEffect, useState } from 'react'

/**
 * View state that should survive switching sections: expanded cards, filters, and each section's last
 * URL query (e.g. /manage?tab=toners). Kept in sessionStorage, because iOS often reloads a home-screen
 * app in the background (memory alone would forget). Cleared on logout.
 */
const PREFIX = 'ui:'
const SEARCH = 'ui-search:'

function read<T>(key: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(key)
    return raw === null ? undefined : (JSON.parse(raw) as T)
  } catch { return undefined } // storage blocked or bad JSON
}
function write(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* storage blocked */ }
}

/** Like useState, but the value is still there when you come back to the page. Values must be JSON. */
export function useRemembered<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => read<T>(PREFIX + key) ?? initial)
  useEffect(() => { write(PREFIX + key, value) }, [key, value])
  return [value, setValue] as const
}

export const rememberSearch = (pathname: string, search: string) => write(SEARCH + pathname, search)
/** Where a section tab should go: the section with the query it had when you left it. */
export const sectionUrl = (pathname: string) => pathname + (read<string>(SEARCH + pathname) ?? '')

export function clearRemembered() {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(PREFIX) || k.startsWith(SEARCH)) sessionStorage.removeItem(k)
  } catch { /* storage blocked */ }
}
