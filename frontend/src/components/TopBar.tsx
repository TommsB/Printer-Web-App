import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import ShinyText from './ShinyText'
import RubberSegment from './RubberSegment'
import { lightness } from '../color'
import { useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../ctx'
import { useNavCounts } from '../navCounts'
import { Icon } from '../icons'
import { ROLE_LV } from '../lib'
import { Segmented } from './Toggle'
import { DEFAULT_SURFACE, DEFAULT_THEME, THEMES, useSurface, useTheme, type Surface } from '../theme'
import { useGoToSection } from '../viewTransition'
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

/**
 * The page title's colours as real values (ShinyText can't take `var(--ink)`): the theme's ink and grey, read
 * again whenever the theme or style on <html> changes. The shine is a light sweep on light themes and a darker
 * one on dark themes, so it shows on either: on the dark first line the grey passes over it; on the grey
 * second line, whichever of white (the card) and ink is further from the grey.
 */
function useTitleColors() {
  const read = () => {
    const css = getComputedStyle(document.documentElement)
    const v = (name: string) => css.getPropertyValue(name).trim()
    const ink = v('--ink') || '#33332F', faint = v('--faint') || '#A3A39B', card = v('--card') || '#ffffff'
    const far = Math.abs(lightness(card) - lightness(faint)) > Math.abs(lightness(ink) - lightness(faint)) ? card : ink
    return { ink, faint, shine1: faint, shine2: far }
  }
  const [colors, setColors] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-surface'] })
    return () => observer.disconnect()
  }, [])
  return colors
}

/** One line of a page title with a slow band of light passing over it every few seconds — never right as a
 *  page opens: the first sweep waits as long as the pause between sweeps. */
const SHINE = { speed: 3, delay: 5, initialDelay: 5, shineWidth: 35, softness: 0.9, angle: 120 } as const

/** The section that was showing last. Every page has its own top bar, so the new page's switch starts its thumb
 *  on the section you came from and stretches it over to the new one. */
let lastSection: string | undefined

/** The old nav's size: 48 px tall like the round buttons beside it, 15 px labels, 18 px side padding. */
const NAV_SIZE = { '--rs-h': '48px', '--rs-font': '15px', '--rs-pad': '18px' } as CSSProperties

/**
 * Desktop section switch (phones use the bottom bar): the old trough-and-pill nav as a React Bits RubberSegment.
 * The pill stretches across the old and new section, snaps in with a small squash, and can be dragged or flicked
 * to another section. Colours come from the theme and Stils (.nv-rubber in index.css). Tapping the current
 * section scrolls back to the top.
 */
function SectionNav() {
  const { pathname } = useLocation()
  const counts = useNavCounts()
  const go = useGoToSection()
  const active = NAV.find((n) => (n.end ? pathname === n.to : pathname === n.to || pathname.startsWith(`${n.to}/`)))?.to ?? NAV[0].to
  const [from] = useState(() => lastSection)
  useEffect(() => { lastSection = active }, [active])
  const items = NAV.map((n) => ({
    value: n.to,
    label: <>{n.label}{counts[n.to] && <span className="badge-n" title={counts[n.to].text}>{counts[n.to].n}</span>}</>,
  }))
  return (
    <RubberSegment
      items={items}
      value={active}
      from={from}
      onChange={(to) => go(to)}
      onReselect={(to) => go(to)}
      radius={24}
      inset={4}
      equalSlots={false}
      aria-label="Sadaļas"
      className="nv-rubber"
      style={NAV_SIZE}
    />
  )
}

export function TopBar({ title, children, sticky }: { title: [string, string]; children?: ReactNode; sticky?: ReactNode }) {
  const colors = useTitleColors()
  const { user, role, logout } = useApp()
  const [heading, setHeading] = useState<HTMLHeadingElement | null>(null)
  const [profile, setProfile] = useState(false)
  const [theme, setTheme] = useTheme()
  const [surface, setSurface] = useSurface()

  return (
    <header className="top">
      <h1 ref={setHeading}>
        <ShinyText text={title[0]} color={colors.ink} shineColor={colors.shine1} {...SHINE} className="top__t1" />
        <ShinyText text={title[1]} color={colors.faint} shineColor={colors.shine2} {...SHINE} className="top__t2" />
      </h1>
      <div className="tools">
        <SectionNav />
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
