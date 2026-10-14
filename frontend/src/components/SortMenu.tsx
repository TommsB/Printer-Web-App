import { useState } from 'react'
import { Icon } from '../icons'
import { ActionMenu } from './TonerRow'

/**
 * How printers are listed on Statuss and Krājumi: by how many cartridges are in stock for them (most first — the
 * default — or fewest first), by name A–Z or Z–A, or in the user's own order
 * ("Pielāgota secība", kept on the server and rearranged by dragging). The choice is kept on this device and
 * shared by both pages.
 */
export type PrinterSort = 'qty-desc' | 'qty-asc' | 'az' | 'za' | 'custom'
const KEY = 'printers.sort'

function stored(key: string): PrinterSort {
  try {
    const v = localStorage.getItem(key)
    if (v === 'qty-desc' || v === 'qty-asc' || v === 'az' || v === 'za' || v === 'custom') return v
  } catch { /* storage blocked */ }
  return 'qty-desc'
}

/** The chosen order of one list (kept on this device under `key`) and a setter that keeps it for next time. */
export function useSortChoice(key: string) {
  const [sort, setSort] = useState<PrinterSort>(() => stored(key))
  return [sort, (s: PrinterSort) => {
    try { localStorage.setItem(key, s) } catch { /* storage blocked: lasts until the page is closed */ }
    setSort(s)
  }] as const
}
/** The printers' order, shared by Statuss and Krājumi. */
export const usePrinterSort = () => useSortChoice(KEY)

const byName = new Intl.Collator('lv', { numeric: true, sensitivity: 'base' })
/** `list` (in the user's own order, as the server sends it) in the chosen order. By stock: the cartridges kept
 *  for the printer, all its toners and drums together; printers with the same count go by name. */
export function sortPrinters<T extends { location: string; toners: { qty: number }[] }>(list: T[], sort: PrinterSort): T[] {
  return sortList(list, sort, (p) => p.location, (p) => p.toners.reduce((n, t) => n + t.qty, 0))
}
/** Any list in the chosen order, given each item's name and count; 'custom' leaves `list` as it is. */
export function sortList<T>(list: T[], sort: PrinterSort, nameOf: (t: T) => string, countOf: (t: T) => number): T[] {
  if (sort === 'custom') return list
  const name = (a: T, b: T) => byName.compare(nameOf(a), nameOf(b))
  return [...list].sort((a, b) => sort === 'az' ? name(a, b) : sort === 'za' ? name(b, a)
    : (sort === 'qty-desc' ? countOf(b) - countOf(a) : countOf(a) - countOf(b)) || name(a, b))
}

/** The sort button: a menu of the orders, and below them the way into rearranging the user's own order. */
export function SortMenu({ sort, onSort, onRearrange }: { sort: PrinterSort; onSort: (s: PrinterSort) => void; onRearrange: () => void }) {
  return (
    <ActionMenu code="Kārtošana" title="Kārtošana"
      button={{ className: 'icon-btn', icon: Icon.sort(18), label: 'Kārtot printerus', title: 'Kārtošana' }}
      items={[
        { label: 'Pēc toneru skaita ↓', checked: sort === 'qty-desc', run: () => onSort('qty-desc') },
        { label: 'Pēc toneru skaita ↑', checked: sort === 'qty-asc', run: () => onSort('qty-asc') },
        { label: 'Alfabēta secībā A–Z', checked: sort === 'az', run: () => onSort('az') },
        { label: 'Alfabēta secībā Z–A', checked: sort === 'za', run: () => onSort('za') },
        { label: 'Pielāgota secība', checked: sort === 'custom', run: () => onSort('custom') },
        { label: 'Mainīt pielāgoto secību…', divider: true, run: () => { onSort('custom'); onRearrange() } },
      ]} />
  )
}
