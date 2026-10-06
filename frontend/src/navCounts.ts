import type { Order, StockRow } from './api'
import { useCached } from './cache'
import { useApp } from './ctx'
import { needUnits } from './lib'

const NO_STOCK: StockRow[] = []
const NO_DEFECTS: Order[] = []

/**
 * The counts on the section tabs (desktop tabs and the phone bar), by route:
 * Krājumi = what is waiting for you there: cartridges still to be ordered + defective cartridges not yet
 * handed over for warranty; Vēsture = detected toner replacements waiting to be confirmed.
 * A tab with nothing waiting has no entry. Kept current by App (reloads after every change and once a minute).
 */
export function useNavCounts(): Record<string, { n: number; text: string }> {
  const { events, company } = useApp()
  const need = needUnits(useCached('stock', NO_STOCK), company)
  const defects = useCached('defects', NO_DEFECTS).filter((o) => o.status === 'defect' && (!company || o.company === company)).length
  const stockText = [need > 0 && `${need} jāpasūta`, defects > 0 && `${defects} ${defects === 1 ? 'defekts' : 'defekti'} jānodod garantijā`].filter(Boolean).join(', ')
  return {
    ...(need + defects > 0 && { '/stock': { n: need + defects, text: stockText } }),
    ...(events.length > 0 && { '/log': { n: events.length, text: `${events.length} jāpārbauda` } }),
  }
}
