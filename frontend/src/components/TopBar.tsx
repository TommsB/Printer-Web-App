import { useState, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useApp } from '../ctx'
import { useNavCounts } from '../navCounts'
import { Icon } from '../icons'
import { ROLE_LV } from '../lib'
import { Segmented } from './Toggle'
import { DEFAULT_SURFACE, DEFAULT_THEME, THEMES, useSurface, useTheme, type Surface } from '../theme'
import { useTabClick } from '../viewTransition'
import { CompactBar } from './CompactBar'
import { Dialog } from './Dialog'
import { NotificationsButton } from './NotificationsButton'
import { AnalyticsSheet } from './AnalyticsSheet'
import { api, type Order, type Printer } from '../api'
import { useApiData } from '../cache'
import { needUnits } from '../lib'
import { PushSettings } from './PushSettings'

export const NAV = [
  { to: '/', label: 'Statuss', icon: Icon.printer, end: true },
  { to: '/stock', label: 'Krājumi', icon: Icon.box, end: false },
  { to: '/log', label: 'Vēsture', icon: Icon.clock, end: false },
  { to: '/manage', label: 'Pārvaldība', icon: Icon.sliders, end: false },
]

/**
 * Page title (two lines, second muted) + nav and round action buttons (the dark one opens the profile window).
 * Once the title scrolls away, a compact bar shows it at the top, with the page's filters (`sticky`) if given.
 */
const SURFACES: { value: Surface; label: string }[] = [{ value: 'glass', label: 'Stikls' }, { value: 'solid', label: 'Parastais' }]

/**
 * The same four round buttons on every page — Analītika, the basket, the bell and the profile — so the section
 * switch beside them never moves. On Krājumi on a phone the page's own basket button (it opens the basket sheet)
 * stands in for this one.
 */
function DeskAnalytics() {
  const [open, setOpen] = useState(false)
  const printers = useApiData<Printer[]>('printers', api.printers, [])
  return (
    <>
      <button className="rb desk-btn" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="Analītika" title="Analītika">{Icon.chart(22)}</button>
      {open && <AnalyticsSheet printers={printers.data} onClose={() => setOpen(false)} />}
    </>
  )
}

/** The basket: how many cartridges are in it, a small truck while something is on order. Goes to Krājumi and
 *  points at the basket there (/stock?cart=…): on a phone it opens the basket sheet, on desktop the basket and
 *  order panels give a ring. */
function DeskCart() {
  const { company } = useApp()
  const navigate = useNavigate()
  const stock = useApiData('stock', api.stock, [])
  const basket = useApiData<Order[]>('basket', () => api.orders('planned'), [])
  const ordered = useApiData<Order[]>('orders', () => api.orders('ordered'), [])
  const mine = (o: Order) => !company || o.company === company
  const n = needUnits(stock.data, company) + basket.data.filter((o) => o.status === 'planned' && mine(o)).reduce((s, o) => s + o.qty, 0)
  const onOrder = ordered.data.filter(mine).reduce((s, o) => s + o.qty, 0)
  return (
    <button className="rb bell desk-btn desk-cart" onClick={() => { navigate(`/stock?cart=${Date.now()}`); window.scrollTo({ top: 0, behavior: 'smooth' }) }} title="Grozs un pasūtījumi"
      aria-label={`Grozs un pasūtījumi (grozā ${n}, pasūtīts ${onOrder})`}>
      {Icon.cart(22)}
      {n > 0 && <span className="badge-n">{n > 99 ? '99+' : n}</span>}
      {onOrder > 0 && <span className="cart-btn__truck" aria-hidden="true">{Icon.truck(13)}</span>}
    </button>
  )
}

export function TopBar({ title, children, sticky }: { title: [string, string]; children?: ReactNode; sticky?: ReactNode }) {
  const { user, role, logout } = useApp()
  const counts = useNavCounts()
  const tabClick = useTabClick()
  const [heading, setHeading] = useState<HTMLHeadingElement | null>(null)
  const [profile, setProfile] = useState(false)
  const [theme, setTheme] = useTheme()
  const [surface, setSurface] = useSurface()

  return (
    <header className="top">
      <h1 ref={setHeading}>{title[0]}<span>{title[1]}</span></h1>
      <div className="tools">
        <nav className="nv" aria-label="Sadaļas">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'on' : '')} onClick={(e) => tabClick(e, n.to)}>
              {n.label}
              {counts[n.to] && <span className="badge-n" title={counts[n.to].text}>{counts[n.to].n}</span>}
            </NavLink>
          ))}
        </nav>
        {/* Company filter pills are hidden for now to keep the phone view simple; ctx.company stays '' (all). */}
        <div className="acts">
          <DeskAnalytics />
          <DeskCart />
          {children}
          <NotificationsButton />
          {/* Opens the profile window (who is logged in, role, Iziet) — it does not log out by itself. */}
          <button className="rb dk" onClick={() => setProfile(true)} title={`Profils: ${user}`} aria-label={`Profils (${user})`} aria-haspopup="dialog">{Icon.user()}</button>
        </div>
      </div>
      {/* Target of the "Pāriet uz saturu" skip link: the next Tab lands on the page's first control. */}
      <span id="content" className="sr" tabIndex={-1} />
      <CompactBar target={heading} title={`${title[0]} ${title[1]}`}>{sticky}</CompactBar>
      {profile && (
        <Dialog.Frame sheet title="Profils" onClose={() => setProfile(false)} confirmDiscard={false}>
          <div className="profile">
            <span className="profile__ic">{Icon.user(24)}</span>
            <span className="profile__txt"><b>{user}</b><span>{ROLE_LV[role]}</span></span>
          </div>
          {/* Izskats: the colour theme, kept on this device. Each button previews its page, card and accent. */}
          <p className="profile__lab" id="themes-lab">Izskats<small>noklusējums: {THEMES.find((t) => t.id === DEFAULT_THEME)!.label}</small></p>
          <div className="themes" role="radiogroup" aria-labelledby="themes-lab">
            {THEMES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} className={theme === t.id ? 'on' : ''} onClick={() => setTheme(t.id)}>
                <span className="themes__sw" style={{ background: t.bg }}><i style={{ background: t.card }} /><b style={{ background: t.mark }} /></span>
                {t.label}
              </button>
            ))}
          </div>
          {/* Stils: plain surfaces, or see-through "glass" ones over a glow in the theme's colour. */}
          <p className="profile__lab">Stils<small>noklusējums: {SURFACES.find((s) => s.value === DEFAULT_SURFACE)!.label}</small></p>
          <Segmented label="Stils" value={surface} onChange={setSurface} options={SURFACES} />
          <PushSettings />
          <Dialog.Footer>
            <Dialog.Cancel>Aizvērt</Dialog.Cancel>
            <button type="button" className="btn primary" onClick={logout}>Iziet</button>
          </Dialog.Footer>
        </Dialog.Frame>
      )}
    </header>
  )
}
