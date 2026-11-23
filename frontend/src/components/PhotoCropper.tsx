import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import { cropPhoto, type Crop } from '../photo'
import { Dialog } from './Dialog'

const MAX_ZOOM = 5

/**
 * "Attēla izgriezums": pick which square of a printer's photo is kept. The photo fills a square window; drag it
 * to move, zoom with the slider, the mouse wheel or two fingers, or use the arrow keys and + / −. The circle shows
 * what the round icon in Statuss shows (the dimmed corners are kept for the larger, square-ish Informācija view).
 *
 * The crop lives in the photo's own pixels (centre + zoom), so the window can be any size on screen.
 */
export function PhotoCropper({ img, initial, onDone, onClose }: {
  img: ImageBitmap
  initial?: Crop
  onDone: (blob: Blob, crop: Crop) => void
  onClose: () => void
}) {
  const minSide = Math.min(img.width, img.height)
  const [view, setView] = useState(() => {
    const c = initial ?? { x: (img.width - minSide) / 2, y: (img.height - minSide) / 2, side: minSide }
    return { cx: c.x + c.side / 2, cy: c.y + c.side / 2, zoom: Math.min(MAX_ZOOM, Math.max(1, minSide / c.side)) }
  })

  // The square kept, kept inside the photo.
  const toCrop = (v: typeof view): Crop => {
    const side = minSide / v.zoom
    const x = Math.min(Math.max(v.cx - side / 2, 0), img.width - side)
    const y = Math.min(Math.max(v.cy - side / 2, 0), img.height - side)
    return { x, y, side }
  }
  const crop = toCrop(view)
  // Store the clamped centre, so dragging past an edge doesn't build up slack that must be dragged back first.
  const settle = (v: typeof view) => {
    const zoom = Math.min(MAX_ZOOM, Math.max(1, v.zoom))
    const c = toCrop({ ...v, zoom })
    return { cx: c.x + c.side / 2, cy: c.y + c.side / 2, zoom }
  }
  const update = (f: (v: typeof view) => typeof view) => setView((v) => settle(f(v)))

  // Draw the kept square into the window, sharp on high-density screens.
  const canvas = useRef<HTMLCanvasElement>(null)
  const [px, setPx] = useState(280)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const observer = new ResizeObserver(() => setPx(el.clientWidth || 280))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    const size = Math.round(px * (window.devicePixelRatio || 1))
    if (el.width !== size) el.width = el.height = size
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(img, crop.x, crop.y, crop.side, crop.side, 0, 0, size, size)
  }, [img, crop.x, crop.y, crop.side, px])

  // Dragging (one pointer) and pinching (two): screen pixels → photo pixels via the current square's scale.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<number | null>(null)
  const distance = () => {
    const [a, b] = [...pointers.current.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    pinch.current = distance()
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(e.pointerId)
    if (!last) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size >= 2) {
      const d = distance()
      if (d && pinch.current) {
        const ratio = d / pinch.current
        update((v) => ({ ...v, zoom: v.zoom * ratio }))
      }
      pinch.current = d
      return
    }
    const scale = crop.side / px
    const dx = (e.clientX - last.x) * scale
    const dy = (e.clientY - last.y) * scale
    update((v) => ({ ...v, cx: v.cx - dx, cy: v.cy - dy }))
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    pinch.current = distance()
  }
  const onWheel = (e: WheelEvent<HTMLDivElement>) => update((v) => ({ ...v, zoom: v.zoom * Math.exp(-e.deltaY * 0.0015) }))
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = crop.side * 0.05
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (moves[e.key]) {
      const [dx, dy] = moves[e.key]
      update((v) => ({ ...v, cx: v.cx + dx, cy: v.cy + dy }))
    } else if (e.key === '+' || e.key === '=') update((v) => ({ ...v, zoom: v.zoom * 1.15 }))
    else if (e.key === '-') update((v) => ({ ...v, zoom: v.zoom / 1.15 }))
    else return
    e.preventDefault()
  }

  // The page must not scroll while the wheel zooms the photo (React's wheel listener is passive).
  const frame = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = frame.current
    if (!el) return
    const stop = (e: globalThis.WheelEvent) => e.preventDefault()
    el.addEventListener('wheel', stop, { passive: false })
    return () => el.removeEventListener('wheel', stop)
  }, [])

  return (
    <Dialog.Frame title="Attēla izgriezums" onClose={onClose} confirmDiscard={false}
      onSubmit={async () => { onDone(await cropPhoto(img, crop), crop) }}>
      <p className="dlg-text">Velciet attēlu, lai izvēlētos redzamo daļu; tuviniet ar slīdni, peles ritenīti vai diviem pirkstiem.</p>
      <div ref={frame} className="pcrop" tabIndex={0} role="group" aria-label="Attēla izgriezums: bultiņas pārvieto, + un − tuvina"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onWheel={onWheel} onKeyDown={onKeyDown}>
        <canvas ref={canvas} className="pcrop__img" aria-hidden="true" />
        <span className="pcrop__mask" aria-hidden="true" />
      </div>
      <label className="pcrop__zoom">
        <span>Tālummaiņa</span>
        <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={view.zoom}
          onChange={(e) => update((v) => ({ ...v, zoom: Number(e.target.value) }))} />
      </label>
      <Dialog.Footer>
        <Dialog.Cancel />
        <Dialog.Confirm>Gatavs</Dialog.Confirm>
      </Dialog.Footer>
    </Dialog.Frame>
  )
}
