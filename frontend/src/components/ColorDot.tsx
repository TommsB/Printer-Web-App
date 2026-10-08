const COLOR_LV: Record<string, string> = { K: 'melns', C: 'ciāns', M: 'purpurs', Y: 'dzeltens', CMY: 'krāsu (C, M, Y)' }

/** CSS classes for a consumable's colour mark: its colour ('k' 'c' 'm' 'y', 'cmy' = one drum code for the
 *  three colours, 'g' = none) plus 'drum' for a drum, which is drawn bigger with a "D" in it. */
function markClass(color: string | null | undefined, kind?: string | null): string {
  const c = (color ?? '').toLowerCase()
  return `${['k', 'c', 'm', 'y', 'cmy'].includes(c) ? c : 'g'}${kind === 'drum' ? ' drum' : ''}`
}
const label = (color: string | null | undefined, kind?: string | null) => {
  const name = COLOR_LV[(color ?? '').toUpperCase()]
  return [kind === 'drum' ? 'Drums' : '', name ?? ''].filter(Boolean).join(', ')
}

interface Props {
  color: string | null | undefined
  kind?: string | null // 'toner' | 'drum' | 'other'; only a drum looks different
  big?: boolean
}

/**
 * The small colour dot in front of a toner / drum code, used in every list. A drum's dot carries a "D", so a
 * black drum is told apart from the black toner at a glance. The colour (and "Drums") is read out / shown
 * on hover.
 */
export function CDot({ color, kind, big }: Props) {
  const text = label(color, kind)
  return (
    <i className={`cdot ${markClass(color, kind)}${big ? ' big' : ''}`} {...(text && { role: 'img', 'aria-label': text, title: text })}>
      {kind === 'drum' ? 'D' : null}
    </i>
  )
}

/** The same mark for the rows that put the colour in a round grey tile (toner rows, levels, Jāpārbauda). */
export function DotTile({ color, kind }: Omit<Props, 'big'>) {
  const text = label(color, kind)
  return (
    <span className="dot" {...(text && { role: 'img', 'aria-label': text, title: text })}>
      <i className={markClass(color, kind)}>{kind === 'drum' ? 'D' : null}</i>
    </span>
  )
}
