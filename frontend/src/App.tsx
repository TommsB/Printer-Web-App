import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { api, onChange, setUnauthorizedHandler, type Role, type Session, type TonerEvent } from './api'
import { AppContext } from './ctx'
import { clearCache, prefetchAll, refresh } from './cache'
import { useNavCounts } from './navCounts'
import { clearRemembered, rememberSearch } from './uiMemory'
import { useTabClick } from './viewTransition'
import { NAV } from './components/TopBar'
import { LoginPage } from './pages/LoginPage'
import { PrintersPage } from './pages/PrintersPage'
import { StockPage } from './pages/StockPage'
import { LogPage } from './pages/LogPage'
import { ManagePage } from './pages/ManagePage'

const COMPANIES = ['Tenapors', 'Tenax', 'Tenax Panel']

/** Same open replacements as before? (ids, plus reserve/locations which the review dialog shows) */
const sameEvents = (a: TonerEvent[], b: TonerEvent[]) =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b)

/**
 * Each section keeps its own scroll position, like a native tab bar: a section opened for the first time
 * starts at the top, and coming back to one returns to where you were.
 */
const scrollBySection = new Map<string, number>()
function useScrollPerSection(pathname: string) {
  const current = useRef(pathname)
  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
    const onScroll = () => { scrollBySection.set(current.current, window.scrollY) }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  // Layout effect: jump before the new section is painted (and before a view-transition snapshot).
  useLayoutEffect(() => {
    current.current = pathname
    window.scrollTo(0, scrollBySection.get(pathname) ?? 0)
  }, [pathname])
}

export default function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined)
  const [role, setRole] = useState<Role>('standard') // only matters for the Lietotāji tab; the server enforces it
  const signIn = (s: Session) => { setRole(s.role); setUser(s.username) }
  const [company, setCompany] = useState('') // '' = all
  const { pathname, search } = useLocation()
  useEffect(() => { rememberSearch(pathname, search) }, [pathname, search])
  useScrollPerSection(pathname)

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null))
    api.me().then((r) => { setRole(r.role); setUser(r.username) }).catch(() => setUser(null))
  }, [])

  // Once logged in, load every page's data in the background so switching pages is instant.
  useEffect(() => { if (user) prefetchAll() }, [user])

  // Detected toner replacements (badge on Žurnāls): checked every minute and whenever the app
  // comes back to the foreground (e.g. reopening the home-screen app on the phone).
  const [events, setEvents] = useState<TonerEvent[]>([])
  // Keep the same array when nothing changed: a new array would change the app context and
  // re-render the header and the current page every minute for no reason.
  const reloadEvents = useCallback(() => api.events()
    .then((next) => setEvents((prev) => (sameEvents(prev, next) ? prev : next)))
    .catch(() => {}), [])
  useEffect(() => {
    if (!user) return
    // The Krājumi count (to order + defects to hand over) reads the cached stock and defect lists: keep them
    // fresh the same way, and right after anything is changed anywhere in the app (an order, a received
    // delivery, a used cartridge, a cartridge marked defective…).
    const counts = () => { refresh('stock', api.stock); refresh('defects', () => api.orders('defect')) }
    const tick = () => { reloadEvents(); counts() }
    reloadEvents()
    const timer = setInterval(tick, 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVisible)
    const offChange = onChange(counts)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); offChange() }
  }, [user, reloadEvents])

  const ctx = useMemo(
    () => user ? {
      user, role, company, setCompany, companies: COMPANIES, events, reloadEvents,
      dropEvent: (id: number) => setEvents((prev) => prev.filter((e) => e.id !== id)),
      logout: () => { clearCache(); clearRemembered(); setEvents([]); api.logout().finally(() => setUser(null)) },
    } : null,
    [user, role, company, events, reloadEvents],
  )

  if (user === undefined) return null
  if (user === null || !ctx) return <LoginPage onLoggedIn={signIn} />

  return (
    <AppContext value={ctx}>
      <a className="skip" href="#content">Pāriet uz saturu</a>
      {/* key: each section mounts fresh, which plays the phone fade-in (.page animation). */}
      <main className="page" key={pathname}>
        <Routes>
          <Route path="/" element={<PrintersPage />} />
          <Route path="/stock" element={<StockPage />} />
          <Route path="/log" element={<LogPage />} />
          <Route path="/manage" element={<ManagePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <BottomNav pathname={pathname} />
    </AppContext>
  )
}

/** Phone tab bar. The white pill is its own element that slides to the active tab (CSS transform). */
function BottomNav({ pathname }: { pathname: string }) {
  const tabClick = useTabClick()
  const counts = useNavCounts()
  const tabIndex = NAV.findIndex((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)))
  return (
    <nav className="bnav" aria-label="Navigācija">
      {tabIndex >= 0 && <span className="bnav__pill" aria-hidden="true" style={{ transform: `translateX(${tabIndex * 100}%)` }} />}
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'on' : '')} onClick={(e) => tabClick(e, n.to)}
          aria-label={counts[n.to] ? `${n.label} (${counts[n.to].text})` : n.label}>
          {n.icon()}
          {counts[n.to] && <span className="badge-n">{counts[n.to].n}</span>}
        </NavLink>
      ))}
    </nav>
  )
}
