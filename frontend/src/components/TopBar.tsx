import { useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
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
        <Dialog.Frame title="Profils" onClose={() => setProfile(false)} confirmDiscard={false}>
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
