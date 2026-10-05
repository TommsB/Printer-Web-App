import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'

/** Moves the item at `from` to `to`. */
function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

interface Drag { from: number; to: number; dy: number }
interface Measure { startY: number; startScroll: number; tops: number[]; heights: number[]; gap: number; lastY: number }

/**
 * Spotify-style custom order: drag a row by its handle (≡) to a new place; the rows in between make room.
 * Works with mouse and touch (pointer events; the handle has touch-action: none so it doesn't scroll),
 * scrolls the page when dragging near the top/bottom edge, and with the keyboard: ↑/↓ on a focused handle.
 */
export function ReorderList<T extends { id: number }>({ items, label, render, onReorder }: {
  items: T[]
  label: (item: T) => string // for the handle's aria-label and the announcement
  render: (item: T) => ReactNode
  onReorder: (items: T[]) => void
}) {
  const list = useRef<HTMLUListElement>(null)
  const m = useRef<Measure | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [said, setSaid] = useState('') // screen-reader announcement

  // Where the dragged row's centre is now → which slot it would drop into.
  const update = (clientY: number, from: number) => {
    const s = m.current
    if (!s) return
    s.lastY = clientY
    const dy = clientY - s.startY + (window.scrollY - s.startScroll)
    const centre = s.tops[from] + s.heights[from] / 2 + dy
    let to = from
    for (let i = 0; i < s.tops.length; i++) {
      const mid = s.tops[i] + s.heights[i] / 2
      if (i > from && centre > mid) to = i
      if (i < from && centre < mid && to === from) to = i
    }
    setDrag({ from, to, dy })
  }

  const start = (e: React.PointerEvent, from: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    const rows = [...(list.current?.children ?? [])] as HTMLElement[]
    const rects = rows.map((r) => r.getBoundingClientRect())
    m.current = {
      startY: e.clientY, startScroll: window.scrollY, lastY: e.clientY,
      tops: rects.map((r) => r.top + window.scrollY), heights: rects.map((r) => r.height),
      gap: rects.length > 1 ? rects[1].top - rects[0].bottom : 0,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ from, to: from, dy: 0 })
  }

  const end = () => {
    if (drag && drag.to !== drag.from) {
      onReorder(move(items, drag.from, drag.to))
      setSaid(`${label(items[drag.from])}: ${drag.to + 1}. vietā`)
    }
    m.current = null
    setDrag(null)
  }

  // Auto-scroll while dragging near the top or bottom edge (the bottom leaves room for the phone tab bar).
  const dragging = drag !== null
  const from = drag?.from ?? 0
  useEffect(() => {
    if (!dragging) return
    let raf = 0
    const tick = () => {
      const s = m.current
      if (s) {
        const step = s.lastY < 90 ? -10 : s.lastY > window.innerHeight - 130 ? 10 : 0
        if (step) { window.scrollBy(0, step); update(s.lastY, from) }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- update only reads refs/stable setters
  }, [dragging, from])

  const keyMove = (e: React.KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : -1
    if (to < 0 || to >= items.length) return
    e.preventDefault()
    onReorder(move(items, i, to))
    setSaid(`${label(items[i])}: ${to + 1}. vietā`)
  }

  // Rows between the old and new slot shift by the dragged row's height to make room.
  const shiftOf = (i: number): number => {
    const s = m.current
    if (!drag || !s || i === drag.from) return 0
    const h = s.heights[drag.from] + s.gap
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -h
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return h
    return 0
  }

  return (
    <>
      <ul ref={list} className={dragging ? 'rlist dragging' : 'rlist'}>
        {items.map((it, i) => {
          const isDragged = drag?.from === i
          return (
            <li key={it.id} className={isDragged ? 'rrow lifted' : 'rrow'}
              style={{ transform: `translateY(${isDragged ? drag.dy : shiftOf(i)}px)` }}>
              <span className="rrow__body">{render(it)}</span>
              <button type="button" className="rrow__handle" aria-label={`Pārvietot: ${label(it)} (${i + 1}. no ${items.length}). Bultiņas uz augšu/leju`}
                onPointerDown={(e) => start(e, i)} onPointerMove={(e) => { if (drag) update(e.clientY, drag.from) }}
                onPointerUp={end} onPointerCancel={end} onKeyDown={(e) => keyMove(e, i)}>
                {Icon.grip(20)}
              </button>
            </li>
          )
        })}
      </ul>
      <span className="sr" aria-live="polite">{said}</span>
    </>
  )
}
