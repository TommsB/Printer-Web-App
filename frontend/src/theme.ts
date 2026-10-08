import { useState } from 'react'

/**
 * Colour themes (Profils → Izskats). The choice is kept on this device (localStorage) and put on
 * <html data-theme>; the colours themselves are the variable sets in index.css. index.html applies the
 * stored theme before the app loads, so there is no flash of the light one.
 */
export type Theme = 'light' | 'dark' | 'blue' | 'green'

/** `bg` / `card` / `mark` are only for the little preview in the picker; `bg` is also the browser bar colour. */
export const THEMES: { id: Theme; label: string; bg: string; card: string; mark: string }[] = [
  { id: 'light', label: 'Gaišais', bg: '#F1F1ED', card: '#FFFFFF', mark: '#33332F' },
  { id: 'dark', label: 'Tumšais', bg: '#26282C', card: '#303338', mark: '#F2F2EF' },
  { id: 'blue', label: 'Zilais', bg: '#EEF2F7', card: '#FFFFFF', mark: '#8FB0EA' },
  { id: 'green', label: 'Zaļais', bg: '#EDF1EC', card: '#FFFFFF', mark: '#86C2A2' },
]
const KEY = 'theme'

export function storedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    if (THEMES.some((x) => x.id === t)) return t as Theme
  } catch { /* storage blocked */ }
  return 'light'
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'light') delete root.dataset.theme
  else root.dataset.theme = theme
  // The phone's status bar / browser bar follows the page background.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES.find((t) => t.id === theme)!.bg)
  try { localStorage.setItem(KEY, theme) } catch { /* storage blocked: the theme lasts until the page is closed */ }
}

/** The current theme and a setter that applies it at once. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(storedTheme)
  return [theme, (t: Theme) => { applyTheme(t); setTheme(t) }] as const
}
