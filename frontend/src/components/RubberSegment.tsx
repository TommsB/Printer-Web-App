/**
 * RubberSegment from React Bits (reactbits.dev), ported to TypeScript. A segmented control whose thumb stretches
 * across the old and new slot, then snaps in with a little squash; it can also be dragged and flicked.
 *
 * Changes for this app:
 *  - The thumb follows the real buttons: their position, height, corner radius and font are measured, so the
 *    app's own switch styles (.seg in its different places — sheets, compact bar, phone) size it, and a
 *    scrolling switch works. The size / radius / inset props only set the defaults of a bare control.
 *  - The pill is a real box (.rubber-segment__pill) under a clipped layer that only swaps the label colour, so it
 *    can have shadows, a rim and backdrop blur (the glass style). A clip-path would cut those off.
 *  - Colour props are optional: left out, the --rs-* colours come from the stylesheet (theme + glass style).
 *  - from: the slot the thumb starts on when it mounts, then travels to the current one (each page has its own
 *    top bar, so this is how the nav's thumb moves between pages).
 *  - onReselect: a tap (or Enter) on the slot that is already chosen.
 *  - className / style go on the track; the base styles are zero-specificity (:where), so any app rule wins.
 */
import {
  useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from 'motion/react'
import './RubberSegment.css'

export type RubberItem = string | { value: string; label: ReactNode; icon?: ReactNode }

const EASE_OUT = [0.23, 1, 0.32, 1] as const
const SPRING_UI = { type: 'spring', duration: 0.3, bounce: 0 } as const
const SPRING_MOMENTUM = { type: 'spring', duration: 0.4, bounce: 0.2 } as const
const SPRING_RELAX = { type: 'spring', duration: 0.16, bounce: 0 } as const
const DILATE = 0.19
const HANDOFF = 0.15
const FLICK = 110
const MAX_VELOCITY = 2000
const DEADZONE = 4
const SLOP = 10
const RUBBER = 0.55
const SIZES = {
  sm: { height: 28, font: 12, pad: 10, min: 36 },
  md: { height: 36, font: 13, pad: 14, min: 44 },
  lg: { height: 44, font: 14, pad: 18, min: 48 },
}
/** Text styles copied from each button onto its copy inside the thumb, so the two labels line up exactly. */
const COPIED = ['fontSize', 'fontWeight', 'letterSpacing', 'columnGap', 'paddingLeft', 'paddingRight', 'justifyContent'] as const

type Slot = { l: number; r: number }
type Geo = { w: number; h: number; top: number; sh: number; radius: number }
type Drag = { id: number; x0: number; slot: number; onThumb: boolean; live: boolean; offset: number; w: number; hist: [number, number][] }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const rubber = (over: number, dim: number) => (over * dim * RUBBER) / (dim + RUBBER * Math.abs(over))
const project = (v: number, glide: number) => {
  const d = 1 - 0.1 * Math.pow(0.05, glide / 100)
  return ((v / 1000) * d) / (1 - d)
}
const velocityOf = (hist: [number, number][], now: number) => {
  const recent = hist.filter(([t]) => now - t <= 100)
  if (recent.length < 2) return 0
  const [t0, x0] = recent[0]
  const [t1, x1] = recent[recent.length - 1]
  return t1 - t0 >= 8 ? ((x1 - x0) / (t1 - t0)) * 1000 : 0
}
const nearestSlot = (slots: Slot[], x: number) => {
  let best = 0
  for (let i = 1; i < slots.length; i++) {
    if (Math.abs((slots[i].l + slots[i].r) / 2 - x) < Math.abs((slots[best].l + slots[best].r) / 2 - x)) best = i
  }
  return best
}

export type RubberSegmentProps = {
  items: RubberItem[]
  value?: string
  defaultValue?: string
  onChange?: (value: string, index: number) => void
  onReselect?: (value: string, index: number) => void
  from?: string
  trackColor?: string
  thumbColor?: string
  textColor?: string
  activeTextColor?: string
  size?: 'sm' | 'md' | 'lg'
  radius?: number
  inset?: number
  equalSlots?: boolean
  stretch?: number
  squash?: number
  speed?: number
  glide?: number
  draggable?: boolean
  disabled?: boolean
  className?: string
  style?: CSSProperties
  'aria-label'?: string
}

export default function RubberSegment({
  items,
  value,
  defaultValue,
  onChange,
  onReselect,
  from,
  trackColor,
  thumbColor,
  textColor,
  activeTextColor,
  size = 'md',
  radius = 10,
  inset = 3,
  equalSlots = true,
  stretch = 100,
  squash = 3,
  speed = 1,
  glide = 75,
  draggable = true,
  disabled = false,
  className = '',
  style,
  'aria-label': ariaLabel = 'Segmented control',
}: RubberSegmentProps) {
  const list = items.map((item) => (typeof item === 'string' ? { value: item, label: item as ReactNode, icon: undefined } : item))
  const [inner, setInner] = useState(defaultValue ?? list[0]?.value)
  const current = value !== undefined ? value : inner
  const index = Math.max(0, list.findIndex((item) => item.value === current))
  const reduce = useReducedMotion()

  const trackRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const copyRefs = useRef<(HTMLSpanElement | null)[]>([])
  const slots = useRef<Slot[]>([])
  const committed = useRef(index)
  const handoff = useRef(0)
  const drag = useRef<Drag | null>(null)
  const gen = useRef(0)
  const fromRef = useRef(from)

  // Edges of the thumb, in the track's content coordinates (scrolling included).
  const edgeL = useMotionValue(0)
  const edgeR = useMotionValue(0)
  const geo = useMotionValue<Geo>({ w: 0, h: 0, top: 0, sh: 0, radius: Math.max(0, radius - inset) })
  const clipPath = useTransform(() => {
    const g = geo.get()
    return `inset(${g.top}px ${Math.max(0, g.w - edgeR.get())}px ${Math.max(0, g.h - g.top - g.sh)}px ${Math.max(0, edgeL.get())}px round ${g.radius}px)`
  })
  const pillWidth = useTransform(() => Math.max(0, edgeR.get() - edgeL.get()))
  const pillTop = useTransform(() => geo.get().top)
  const pillHeight = useTransform(() => geo.get().sh)
  const pillRadius = useTransform(() => geo.get().radius)
  const thumbW = useTransform(() => geo.get().w)
  const thumbH = useTransform(() => geo.get().h)

  const t = (seconds: number) => seconds / speed

  const jumpTo = (i: number) => {
    const s = slots.current[i]
    if (!s) return
    window.clearTimeout(handoff.current)
    gen.current += 1
    edgeL.jump(s.l)
    edgeR.jump(s.r)
  }

  const measure = () => {
    const track = trackRef.current
    const first = itemRefs.current[0]
    if (!track || !first) return
    slots.current = list.map((_, i) => {
      const el = itemRefs.current[i]
      return el ? { l: el.offsetLeft, r: el.offsetLeft + el.offsetWidth } : { l: 0, r: 0 }
    })
    const css = getComputedStyle(first)
    geo.set({
      w: Math.max(track.scrollWidth, track.clientWidth),
      h: Math.max(track.scrollHeight, track.clientHeight),
      top: first.offsetTop,
      sh: first.offsetHeight,
      radius: Math.min(parseFloat(css.borderTopLeftRadius) || 0, first.offsetHeight / 2),
    })
    list.forEach((_, i) => {
      const el = itemRefs.current[i]
      const copy = copyRefs.current[i]
      if (!el || !copy) return
      const c = getComputedStyle(el)
      copy.style.left = `${el.offsetLeft}px`
      copy.style.top = `${el.offsetTop}px`
      copy.style.width = `${el.offsetWidth}px`
      copy.style.height = `${el.offsetHeight}px`
      COPIED.forEach((p) => { copy.style[p] = c[p] })
    })
    // A late re-measure (fonts loaded, first resize callback) must not cut a running slide short.
    if (!edgeL.isAnimating() && !edgeR.isAnimating()) jumpTo(committed.current)
  }

  const land = (to: number, v: number | null, flick: boolean, withSquash: boolean) => {
    const b = slots.current[to]
    if (!b) return
    const g = ++gen.current
    const dir = Math.sign((b.l + b.r) / 2 - (edgeL.get() + edgeR.get()) / 2) || 1
    const [lead, leadTo, trail, trailTo] = (dir > 0 ? [edgeR, b.r, edgeL, b.l] : [edgeL, b.l, edgeR, b.r]) as [MotionValue<number>, number, MotionValue<number>, number]
    const velocityFor = (mv: MotionValue<number>) => clamp(v === null ? mv.getVelocity() : v, -MAX_VELOCITY, MAX_VELOCITY)
    animate(lead, leadTo, { ...(flick ? SPRING_MOMENTUM : SPRING_UI), duration: t(flick ? 0.4 : 0.3), velocity: velocityFor(lead) })
    const trailVelocity = velocityFor(trail)
    if (!withSquash || squash <= 0) {
      animate(trail, trailTo, { ...SPRING_UI, duration: t(0.3), velocity: trailVelocity })
      return
    }
    animate(trail, trailTo + dir * squash, { ...SPRING_UI, duration: t(0.3), velocity: trailVelocity }).then(() => {
      if (gen.current === g) animate(trail, trailTo, { ...SPRING_RELAX, duration: t(0.16) })
    })
  }

  const travel = (fromSlot: number, to: number) => {
    const a = slots.current[fromSlot]
    const b = slots.current[to]
    if (!a || !b) return
    window.clearTimeout(handoff.current)
    gen.current += 1
    if (reduce) {
      edgeL.jump(b.l)
      edgeR.jump(b.r)
      return
    }
    const u = stretch / 100
    const tween = { duration: t(DILATE), ease: EASE_OUT }
    animate(edgeL, b.l + (Math.min(a.l, b.l) - b.l) * u, tween)
    animate(edgeR, b.r + (Math.max(a.r, b.r) - b.r) * u, tween)
    handoff.current = window.setTimeout(() => land(to, null, false, true), t(HANDOFF) * 1000)
  }

  const listKey = list.map((item) => item.value).join('|')
  useLayoutEffect(() => {
    measure()
    // Once, on mount: start on `from` and travel to the current slot.
    const start = fromRef.current === undefined ? -1 : list.findIndex((item) => item.value === fromRef.current)
    fromRef.current = undefined
    if (start >= 0 && start !== committed.current && !reduce) {
      jumpTo(start)
      travel(start, committed.current)
    }
    // The track and every button: a label can change width (a count badge) without the track resizing.
    const observer = new ResizeObserver(measure)
    if (trackRef.current) observer.observe(trackRef.current)
    itemRefs.current.forEach((el) => el && observer.observe(el))
    document.fonts?.ready.then(measure)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, size, inset, equalSlots])

  useEffect(() => {
    if (!drag.current && committed.current !== index) {
      committed.current = index
      jumpTo(index)
    }
  })

  useEffect(
    () => () => {
      window.clearTimeout(handoff.current)
      edgeL.stop()
      edgeR.stop()
    },
    [edgeL, edgeR],
  )

  const commit = (i: number) => {
    committed.current = i
    if (i === index) return
    if (value === undefined) setInner(list[i].value)
    onChange?.(list[i].value, i)
  }

  const localX = (e: ReactPointerEvent) => {
    const track = trackRef.current
    if (!track) return 0
    return e.clientX - track.getBoundingClientRect().left - track.clientLeft + track.scrollLeft
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLButtonElement>, i: number) => {
    if (disabled || drag.current || e.button !== 0 || !trackRef.current) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture is optional */
    }
    const x = localX(e)
    const onThumb = draggable && x >= edgeL.get() && x <= edgeR.get()
    drag.current = { id: e.pointerId, x0: x, slot: i, onThumb, live: false, offset: 0, w: 0, hist: [[e.timeStamp, x]] }
    if (onThumb) {
      window.clearTimeout(handoff.current)
      gen.current += 1
      edgeL.stop()
      edgeR.stop()
    } else if (!reduce) {
      e.currentTarget.dataset.pressed = ''
    }
  }

  const handlePointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id || !d.onThumb) return
    const x = localX(e)
    d.hist.push([e.timeStamp, x])
    if (d.hist.length > 8) d.hist.shift()
    if (!d.live) {
      if (Math.abs(x - d.x0) < DEADZONE) return
      d.live = true
      d.offset = x - edgeL.get()
      d.w = edgeR.get() - edgeL.get()
      if (trackRef.current) trackRef.current.dataset.held = ''
    }
    // The thumb may travel from the first slot's left edge to the last slot's right edge, and stretches like
    // rubber past them.
    const minL = slots.current[0]?.l ?? 0
    const maxR = slots.current[slots.current.length - 1]?.r ?? 0
    const l = x - d.offset
    const maxL = maxR - d.w
    if (reduce) {
      const c = clamp(l, minL, maxL)
      edgeL.set(c)
      edgeR.set(c + d.w)
    } else if (l < minL) {
      edgeL.set(minL)
      edgeR.set(minL + d.w - rubber(minL - l, d.w))
    } else if (l > maxL) {
      edgeR.set(maxR)
      edgeL.set(maxL + rubber(l - maxL, d.w))
    } else {
      edgeL.set(l)
      edgeR.set(l + d.w)
    }
  }

  const release = () => {
    const d = drag.current
    drag.current = null
    if (trackRef.current) delete trackRef.current.dataset.held
    const el = d ? itemRefs.current[d.slot] : null
    if (el) delete el.dataset.pressed
    return d
  }

  const handlePointerUp = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    release()
    const x = localX(e)
    if (!d.live) {
      if (Math.abs(x - d.x0) <= SLOP) {
        if (d.slot !== committed.current) {
          const fromSlot = committed.current
          commit(d.slot)
          travel(fromSlot, d.slot)
        } else {
          onReselect?.(list[d.slot].value, d.slot)
        }
      }
      return
    }
    const v = velocityOf(d.hist, e.timeStamp)
    const flick = Math.abs(v) > FLICK
    let to = nearestSlot(slots.current, (edgeL.get() + edgeR.get()) / 2 + project(v, glide))
    if (flick && to === committed.current) to = clamp(to + Math.sign(v), 0, list.length - 1)
    commit(to)
    if (reduce) jumpTo(to)
    else land(to, v, flick, flick)
  }

  const handlePointerCancel = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    release()
    if (!d.live) return
    if (reduce) jumpTo(committed.current)
    else land(committed.current, null, false, false)
  }

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (disabled) return
    const last = list.length - 1
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(last, index + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else if ((e.key === 'Enter' || e.key === ' ') && onReselect) {
      e.preventDefault()
      onReselect(list[index].value, index)
      return
    }
    if (next === null) return
    e.preventDefault()
    if (next === index) return
    commit(next)
    jumpTo(next)
    itemRefs.current[next]?.focus()
  }

  const preset = SIZES[size] || SIZES.md
  const vars: Record<string, string> = {
    '--rs-radius': `${radius}px`,
    '--rs-inset': `${inset}px`,
    '--rs-thumb-radius': `${Math.max(0, radius - inset)}px`,
    '--rs-h': `${preset.height}px`,
    '--rs-font': `${preset.font}px`,
    '--rs-pad': `${preset.pad}px`,
    '--rs-min': `${preset.min}px`,
  }
  if (trackColor) vars['--rs-track'] = trackColor
  if (thumbColor) vars['--rs-thumb'] = thumbColor
  if (textColor) vars['--rs-ink'] = textColor
  if (activeTextColor) vars['--rs-ink-active'] = activeTextColor

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      data-equal={equalSlots ? '' : undefined}
      data-draggable={draggable && !disabled ? '' : undefined}
      className={`rubber-segment${className ? ` ${className}` : ''}`}
      style={{ ...(vars as CSSProperties), ...style }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
    >
      {list.map((item, i) => (
        <button
          key={item.value}
          ref={(el) => { itemRefs.current[i] = el }}
          type="button"
          role="radio"
          aria-checked={i === index}
          tabIndex={i === index ? 0 : -1}
          disabled={disabled}
          className="rubber-segment__item"
          onPointerDown={(e) => handlePointerDown(e, i)}
          onKeyDown={handleKeyDown}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
      <motion.div className="rubber-segment__pill" aria-hidden="true"
        style={{ x: edgeL, width: pillWidth, top: pillTop, height: pillHeight, borderRadius: pillRadius }} />
      <motion.div className="rubber-segment__thumb" aria-hidden="true" style={{ clipPath, width: thumbW, height: thumbH }}>
        {list.map((item, i) => (
          <span key={item.value} ref={(el) => { copyRefs.current[i] = el }} className="rubber-segment__copy">
            {item.icon}
            {item.label}
          </span>
        ))}
      </motion.div>
    </div>
  )
}
