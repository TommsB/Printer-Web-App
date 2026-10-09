import { useState } from 'react'

/**
 * Colour themes (Profils → Izskats). The choice is kept on this device (localStorage) and put on
 * <html data-theme>; the colours themselves are the variable sets in index.css. index.html applies the
 * stored theme before the app loads, so there is no flash of the light one.
 */
export type Theme = 'light' | 'dark' | 'blue' | 'green' | 'neon'

/** `bg` / `card` / `mark` are only for the little preview in the picker; `bg` is also the browser bar colour. */
export const THEMES: { id: Theme; label: string; bg: string; card: string; mark: string }[] = [
  { id: 'light', label: 'Gaišais', bg: '#F1F1ED', card: '#FFFFFF', mark: '#33332F' },
  { id: 'dark', label: 'Tumšais', bg: '#26282C', card: '#303338', mark: '#F2F2EF' },
  { id: 'blue', label: 'Zilais', bg: '#EEF2F7', card: '#FFFFFF', mark: '#8FB0EA' },
  { id: 'green', label: 'Zaļais', bg: '#EDF1EC', card: '#FFFFFF', mark: '#86C2A2' },
  { id: 'neon', label: 'Neons', bg: '#14121F', card: '#1F1B30', mark: '#FF7AB8' },
]
const KEY = 'theme'

export function storedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    if (THEMES.some((x) => x.id === t)) return t as Theme
  } catch { /* storage blocked */ }
  return DEFAULT_THEME
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'light') delete root.dataset.theme
  else root.dataset.theme = theme
  // The phone's status bar / browser bar follows the page background.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES.find((t) => t.id === theme)!.bg)
  try { localStorage.setItem(KEY, theme) } catch { /* storage blocked: the theme lasts until the page is closed */ }
}

/**
 * Surfaces (Profils → Izskats → Stils): "glass" makes cards, bars and sheets see-through over a soft glow
 * (index.css, :root[data-surface="glass"]); "solid" is the plain look. Kept on this device like the theme, and
 * put on <html data-surface>.
 *
 * The defaults — what a device shows until someone picks otherwise — are the light theme with glass.
 */
export const DEFAULT_THEME: Theme = 'light'
export const DEFAULT_SURFACE: Surface = 'glass'
export type Surface = 'solid' | 'glass'
const SURFACE_KEY = 'surface'

export function storedSurface(): Surface {
  try { if (localStorage.getItem(SURFACE_KEY) === 'solid') return 'solid' } catch { /* storage blocked */ }
  return DEFAULT_SURFACE
}

export function applySurface(surface: Surface) {
  const root = document.documentElement
  root.dataset.surface = surface
  try { localStorage.setItem(SURFACE_KEY, surface) } catch { /* storage blocked: lasts until the page is closed */ }
}

/** The current surface style and a setter that applies it at once. */
export function useSurface() {
  const [surface, setSurface] = useState<Surface>(storedSurface)
  return [surface, (s: Surface) => { applySurface(s); setSurface(s) }] as const
}

/** The current theme and a setter that applies it at once. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(storedTheme)
  return [theme, (t: Theme) => { applyTheme(t); setTheme(t) }] as const
}
