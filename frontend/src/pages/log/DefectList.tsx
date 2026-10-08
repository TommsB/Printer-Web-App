import { useState, type ReactNode } from 'react'
import { api, type Order } from '../../api'
import { useApiData } from '../../cache'
import { DefectDialog } from '../../components/DefectFiles'
import { matches, SearchBox } from '../../components/SearchBox'
import { Icon } from '../../icons'
import { DEFECT_STATUS, fmtDate, fmtNum } from '../../lib'
import { CDot } from '../../components/ColorDot'

/** Recorded = warning sign; handed over = waiting (the same clock as an order on its way); replacement
 *  arrived = the "received" icon; rejected = ×. */
const STATUS_ICON: Record<Order['status'], () => ReactNode> = {
  planned: () => Icon.cart(16),
  defect: () => Icon.hazard(),
  ordered: () => Icon.clock(18),
  received: () => Icon.trendUp(),
  cancelled: () => Icon.close(16),
}

/**
 * Vēsture → Defekti: every cartridge that was marked defective, newest first — which toner, which printer,
 * what was wrong, when, and where the claim stands. Tapping one opens its details and photos/files.
 * Read-only: handing over, receiving the replacement and rejecting are done in Krājumi.
 */
export function DefectList() {
  // The same cached list as "Pasūtījumi" (all orders); the defects are the warranty ones.
  const { data: orders, loading, reload } = useApiData<Order[]>('orders-all', () => api.orders('all'), [])
  const [query, setQuery] = useState('')
  const [details, setDetails] = useState<Order | null>(null)

  const defects = orders.filter((o) => o.warranty)
  const shown = defects.filter((o) => matches(query, o.code, o.location, o.model, o.defect, o.note, DEFECT_STATUS[o.status].label))

  return (
    <section className="pane logpane">
      <div className="log-tools">
        <SearchBox value={query} onChange={setQuery} placeholder="Meklēt pēc tonera, printera, defekta vai statusa…" />
      </div>
      {shown.length === 0 && (
        <p className="muted empty">{loading && orders.length === 0 ? 'Ielādē…' : defects.length === 0 ? 'Vēl nav neviena defekta.' : 'Nekas netika atrasts.'}</p>
      )}
      <ul className="evlist">
        {shown.map((o) => {
          const st = DEFECT_STATUS[o.status]
          return (
            <li key={o.id} className="ev">
              <button className="ev__main" onClick={() => setDetails(o)} aria-haspopup="dialog">
                <span className={`ev__ic ${st.cls}`}>{STATUS_ICON[o.status]()}</span>
                <span className="ev__body">
                  <span className="ev__l1">
                    <CDot color={o.color} kind={o.kind} />
                    <b>{o.code}</b>
                    <span className="ev__pr">{o.location}</span>
                  </span>
                  <span className="ev__l2">
                    {o.defect || 'Defekts'}
                    {o.removed_pct != null && ` · izņemts pie ${o.removed_pct}%`}
                    {o.pages_printed != null && ` · ${fmtNum(o.pages_printed)} lapas`}
                    {o.files > 0 && <span className="ev__files">{Icon.clip(12)}{o.files}</span>}
                  </span>
                </span>
                <span className="dfx">
                  <b className={`dfx__st ${o.status}`}>{st.label}</b>
                  <small>{fmtDate(o.created_ts)}</small>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {details && <DefectDialog order={details} onClose={() => setDetails(null)} onChange={() => { reload().catch(() => {}) }} />}
    </section>
  )
}
