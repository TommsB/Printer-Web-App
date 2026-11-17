/** Colour helpers for ShinyText (from React Bits) and the page titles that use it. */

export type Rgba = [number, number, number, number]

let paint: CanvasRenderingContext2D | null = null

/** Any CSS colour value (hex, rgb(), a name…; not `var(--x)`) as [r, g, b, alpha], read through a canvas. */
export const parseColor = (value: string): Rgba | null => {
  if (typeof document === 'undefined') return null
  if (!paint) paint = document.createElement('canvas').getContext('2d')
  if (!paint) return null
  paint.fillStyle = '#000000'
  paint.fillStyle = value
  const resolved = String(paint.fillStyle)
  if (resolved.startsWith('#')) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(resolved.slice(i, i + 2), 16))
    return [r, g, b, 1]
  }
  const parts = resolved.match(/[\d.]+/g)
  if (!parts || parts.length < 3) return null
  return [Number(parts[0]), Number(parts[1]), Number(parts[2]), parts.length > 3 ? Number(parts[3]) : 1]
}

/** How light a colour is (0 = black … 1 = white), to pick a shine that shows on any theme. */
export const lightness = (value: string): number => {
  const c = parseColor(value)
  return c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : 0
}
