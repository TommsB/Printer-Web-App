import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, fmtClock, fmtTime, parseTs, type PushHistory, type PushLogItem } from '../api'
import { useApiData } from '../cache'
import { Icon } from '../icons'
import { dayLabel } from '../lib'
import { Dialog } from './Dialog'

const KIND: Record<PushLogItem['category'], { icon: () => ReactNode; cls: string }> = {
  printer: { icon: () => Icon.printer(18), cls: 'k-out' },
  replacement: { icon: () => Icon.swap(), cls: 'k-move' },
  toner: { icon: () => Icon.box(18), cls: 'k-wait' },
}
const EMPTY: PushHistory = { items: [], seen: 0, unread: 0 }
const REFRESH_MS = 60_000

/**
 * Bell button in the top bar: the notifications the server has announced (the same ones that are pushed to
 * phones), newest first, with a badge for the ones this user hasn't seen. Everyone sees the same history,
 * whether or not they have push switched on. Opening the list marks it as seen; tapping an entry goes there.
 */
export function NotificationsButton() {
  const { data, setData, reload } = useApiData<PushHistory>('push-history', api.pushHistory, EMPTY)
  const [open, setOpen] = useState(false)
  // What counted as unread when the list was opened — so those rows stay highlighted while it is open.
  const [seenAtOpen, setSeenAtOpen] = useState(0)
  const navigate = useNavigate()

  // Keep the badge fresh: every minute, and when the app comes back to the foreground.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') reload().catch(() => {}) }
    const timer = setInterval(tick, REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [reload])

  const show = async () => {
    setSeenAtOpen(data.seen)
    setOpen(true)
    const fresh = await reload().catch(() => data)
    const newest = fresh.items[0]?.id ?? 0
    if (newest > fresh.seen) {
      setData({ ...fresh, seen: newest, unread: 0 }) // the badge clears at once
      api.pushSeen(newest).catch(() => {})
    }
  }
  const go = (item: PushLogItem) => { setOpen(false); navigate(item.url) }

  // Group by day, like Vēsture.
  const days: { day: string; items: PushLogItem[] }[] = []
  for (const item of data.items) {
    const day = (parseTs(item.ts) ? item.ts : '').slice(0, 10)
    if (days.length && days[days.length - 1].day === day) days[days.length - 1].items.push(item)
    else days.push({ day, items: [item] })
  }

  return (
    <>
      <button className="rb bell" onClick={show} aria-haspopup="dialog" title="Paziņojumi"
        aria-label={data.unread ? `Paziņojumi (${data.unread} ${data.unread % 10 === 1 && data.unread % 100 !== 11 ? 'jauns' : 'jauni'})` : 'Paziņojumi'}>
        {Icon.bell()}
        {data.unread > 0 && <span className="badge-n">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <Dialog.Frame title="Paziņojumi" onClose={() => setOpen(false)} confirmDiscard={false}>
          {data.items.length === 0 && <p className="dlg-text muted">Vēl nav neviena paziņojuma. Šeit parādīsies tas, par ko lietotne ziņo: printeris nevar drukāt, nomainīts toneris, beidzas toneris bez rezerves.</p>}
          {days.map(({ day, items }) => (
            <div key={day} className="nday">
              <div className="nday__head">{day ? dayLabel(day) : ''}</div>
              <ul className="evlist">
                {items.map((n) => {
                  const k = KIND[n.category] ?? KIND.printer
                  return (
                    <li key={n.id} className={n.id > seenAtOpen ? 'ev unread' : 'ev'}>
                      <button type="button" className="ev__main" onClick={() => go(n)} title={fmtTime(n.ts)}>
                        <span className={`ev__ic ${k.cls}`}>{k.icon()}</span>
                        <span className="ev__body">
                          <span className="ev__l1"><b className="nt">{n.title}</b></span>
                          <span className="nbody">{n.body}</span>
                        </span>
                        <span className="ntime">{fmtClock(n.ts)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
          <Dialog.Footer>
            <Dialog.Cancel>Aizvērt</Dialog.Cancel>
          </Dialog.Footer>
        </Dialog.Frame>
      )}
    </>
  )
}
