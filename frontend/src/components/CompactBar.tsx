import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Compact header (like Spotify's): fades in at the top once `target` (a page's big title) has scrolled
 * above the top edge. Title centred, optional button on the left (`start`), optional filters underneath (children).
 */
export function CompactBar({ target, active = true, title, start, className, children }: {
  target: Element | null
  active?: boolean // e.g. only while the printer details are open
  title: ReactNode
  start?: ReactNode
  className?: string
  children?: ReactNode
}) {
  const bar = useRef<HTMLDivElement>(null)
  const [past, setPast] = useState(false)
  const on = active && past

  // Past = the title is above the top edge (not when it's below, e.g. on a short page).
  useEffect(() => {
    if (!target) return
    const io = new IntersectionObserver(([e]) => setPast(!e.isIntersecting && e.boundingClientRect.top < 0))
    io.observe(target)
    return () => io.disconnect()
  }, [target])

  // While shown, publish the bar's height so other sticky things (Žurnāls day headings) sit below it.
  useEffect(() => {
    const root = document.documentElement
    const el = bar.current
    if (!on || !el) return
    const ro = new ResizeObserver(() => root.style.setProperty('--hdr-h', `${el.offsetHeight}px`))
    ro.observe(el)
    return () => { ro.disconnect(); root.style.removeProperty('--hdr-h') }
  }, [on])

  // inert while hidden: its buttons can't be tabbed to or read out twice.
  return createPortal(
    <div ref={bar} className={`cbar${on ? ' on' : ''}${className ? ` ${className}` : ''}`} inert={!on}>
      <div className={start ? 'cbar__row has-start' : 'cbar__row'}>
        {start && <span className="cbar__start">{start}</span>}
        <div className="cbar__title">{title}</div>
      </div>
      {children && <div className="cbar__extra">{children}</div>}
    </div>,
    document.body,
  )
}
