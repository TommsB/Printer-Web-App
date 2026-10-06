import type { Order, StockRow } from './api'
import { useCached } from './cache'
import { useApp } from './ctx'
import { needUnits } from './lib'

const NO_STOCK: StockRow[] = []
const NO_ORDERS: Order[] = []

/**
 * The counts on the section tabs (desktop tabs and the phone bar), by route:
 * Krājumi = what is waiting for you there: cartridges in the basket (missing to the norm + added by hand) +
 * defective cartridges not yet handed over for warranty; Vēsture = detected toner replacements waiting to be
 * confirmed. A tab with nothing waiting has no entry. Kept current by App (reloads after every change and
 * once a minute).
 */
export function useNavCounts(): Record<string, { n: number; text: string }> {
  const { events, company } = useApp()
  const mine = (o: Order) => !company || o.company === company
  const basket = needUnits(useCached('stock', NO_STOCK), company)
    + useCached('basket', NO_ORDERS).filter((o) => o.status === 'planned' && mine(o)).reduce((n, o) => n + o.qty, 0)
  const defects = useCached('defects', NO_ORDERS).filter((o) => o.status === 'defect' && mine(o)).length
  const stockText = [basket > 0 && `${basket} grozā`, defects > 0 && `${defects} ${defects === 1 ? 'defekts' : 'defekti'} jānodod garantijā`].filter(Boolean).join(', ')
  return {
    ...(basket + defects > 0 && { '/stock': { n: basket + defects, text: stockText } }),
    ...(events.length > 0 && { '/log': { n: events.length, text: `${events.length} jāpārbauda` } }),
  }
}
