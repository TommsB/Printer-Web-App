import { flushSync } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { sectionUrl } from './uiMemory'

/**
 * Small wrapper around the browser's View Transitions API (stable React — no react@canary needed).
 *
 * How it animates: elements with a `view-transition-name` (set inline on list rows/groups) glide from
 * their old to their new position/size; everything else cross-fades. Styling lives in index.css.
 * Browsers without support, and phones with "Reduce Motion" on, just apply the change instantly.
 */
type VTDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void>; updateCallbackDone: Promise<void> }
}

/** Apply a React state change with a view transition. `kind` lands on <html data-vt> for kind-specific CSS. */
export function withViewTransition(update: () => void, kind: 'state' | 'tab' | 'panel-open' | 'panel-close' = 'state'): Promise<void> {
  const doc = document as VTDocument
  // Phones: no view transitions. On iPhone the snapshots are drawn above everything, so the fixed bottom bar
  // flashed and moving cards slid over it. Phones use small CSS animations instead (see index.css).
  if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce), (max-width: 800px)').matches) {
    update()
    return Promise.resolve()
  }
  const root = document.documentElement
  root.dataset.vt = kind
  // flushSync: the DOM must be updated inside the callback, or the "new" snapshot would still be the old page.
  const t = doc.startViewTransition(() => flushSync(update))
  t.finished.finally(() => { if (root.dataset.vt === kind) delete root.dataset.vt })
  return t.updateCallbackDone.catch(() => {})
}

/**
 * Name for an element that should glide/fade on its own during a transition (must be unique on the page).
 * `shape` = its corner radius class (index.css): the moving snapshot is clipped to its current size with those
 * corners, so a growing/shrinking element reveals/hides content instead of showing its end state at once.
 */
export const vtName = (name: string, shape?: 'pane' | 'list' | 'row' | 'card' | 'card-open' | 'rv'): React.CSSProperties =>
  ({ viewTransitionName: name, ...(shape && { viewTransitionClass: shape }) }) as React.CSSProperties

/** onClick for the section tabs (top nav + phone bottom bar): a short cross-fade between sections. */
export function useTabClick() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return (e: React.MouseEvent, to: string) => {
    // Let the browser handle new-tab clicks; nothing to animate when already there.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    // Tapping the section you're already in scrolls it back to the top (as on iOS).
    if (to === pathname) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
      return
    }
    e.preventDefault()
    const url = sectionUrl(to) // back to the section as you left it (e.g. the Pārvaldība tab)
    // Phones: plain navigation. iPhone Safari flashes the fixed bottom bar in view-transition snapshots, so there
    // the pill slides and the page fades in with ordinary CSS instead (.bnav__pill, .page animation in index.css).
    if (window.matchMedia('(max-width: 800px)').matches) navigate(url)
    else withViewTransition(() => navigate(url), 'tab')
  }
}
