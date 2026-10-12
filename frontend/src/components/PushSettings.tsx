import { useEffect, useState } from 'react'
import { api, type PushPrefs, type PushSchedule, type PushStatus } from '../api'
import { currentSubscription, disablePush, enablePush, pushSupport, type PushSupport } from '../push'
import { Toggle } from './Toggle'

const WHY_NOT: Record<Exclude<PushSupport, 'ok'>, string> = {
  insecure: 'Paziņojumi darbojas tikai, ja lietotne atvērta ar https adresi.',
  'ios-install': 'iPhone: vispirms pievienojiet lietotni sākuma ekrānam (Safari → Kopīgot → Pievienot sākuma ekrānam) un atveriet to no turienes.',
  unsupported: 'Šī pārlūkprogramma neatbalsta paziņojumus.',
  denied: 'Paziņojumi šai lapai ir bloķēti. Atļaujiet tos ierīces vai pārlūka iestatījumos un atveriet šo logu vēlreiz.',
}
const KINDS: { key: keyof PushPrefs; label: string; hint: string }[] = [
  { key: 'printer', label: 'Printeris nevar drukāt', hint: 'Iestrēdzis papīrs, atvērtas durtiņas, nav papīra, vai printeris neatbild' },
  { key: 'replacement', label: 'Nomainīts toneris vai drums', hint: 'Jāapstiprina sadaļā Vēsture' },
  { key: 'toner', label: 'Zems pēdējais toneris vai drums', hint: 'Toneris zem 40% (drums zem 15%) vai beigsies 2 nedēļu laikā, un rezervē nav neviena' },
]
// Index = the server's weekday number (0 = Monday).
const DAYS = [
  { short: 'P', name: 'Pirmdiena' }, { short: 'O', name: 'Otrdiena' }, { short: 'T', name: 'Trešdiena' },
  { short: 'C', name: 'Ceturtdiena' }, { short: 'Pk', name: 'Piektdiena' }, { short: 'S', name: 'Sestdiena' },
  { short: 'Sv', name: 'Svētdiena' },
]
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
/** What a device has until its hours are set: off, working hours on weekdays (the same as the server's default). */
const NO_HOURS: PushSchedule = { enabled: false, start: '08:00', end: '17:00', days: [0, 1, 2, 3, 4] }

/**
 * Profile window → Paziņojumi. "Šajā ierīcē" is per device (each phone/browser is switched on separately,
 * because the browser has to ask for permission there), and so are the notification hours (Paziņojumu laiks:
 * from–to and weekdays) — they can only be set while this device's notifications are on, and are locked
 * otherwise. The three kinds are per user, for all their devices. Every switch applies at once.
 */
export function PushSettings() {
  const support = pushSupport()
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [endpoint, setEndpoint] = useState<string | null>(null) // this device's subscription, if on
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('') // result of the last action (error or test outcome)

  useEffect(() => {
    let alive = true
    api.push().then(async (s) => {
      const sub = await currentSubscription().catch(() => null)
      if (!alive) return
      setStatus(s)
      // On only if the server still knows this device (e.g. it was removed after an admin deleted the user).
      setEndpoint(sub && s.endpoints.includes(sub.endpoint) ? sub.endpoint : null)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  const toggleDevice = async (on: boolean) => {
    if (!status || busy) return
    setBusy(true)
    setNote('')
    try {
      if (on) {
        const ep = (await enablePush(status.public_key)).endpoint
        setEndpoint(ep)
        // a device that was just switched on starts with whatever the server has for it (nothing, the first time)
        api.push().then(setStatus).catch(() => {})
      } else { await disablePush(); setEndpoint(null) }
    } catch (err) {
      // Our own messages (permission refused) are already in Latvian; the browser's own errors are not.
      const detail = err instanceof Error ? err.message : ''
      setNote(/[āčēģīķļņšūž]/i.test(detail) ? detail : `Neizdevās ${on ? 'ieslēgt' : 'izslēgt'} paziņojumus šajā ierīcē${detail ? ` (${detail})` : ''}.`)
    } finally { setBusy(false) }
  }

  const setKind = async (key: keyof PushPrefs, on: boolean) => {
    if (!status) return
    const prefs = { ...status.prefs, [key]: on }
    setStatus({ ...status, prefs }) // optimistic
    try { await api.pushPrefs(prefs) } catch { setStatus(status) }
  }

  const test = async () => {
    if (!endpoint || busy) return
    setBusy(true)
    setNote('')
    try {
      const r = await api.pushTest(endpoint)
      // 404/410 = this device's registration is gone (fix: off and on again). Anything else is a server-side
      // problem — show what the push service said, so it can be fixed there.
      const gone = r.status === 404 || r.status === 410
      setNote(r.ok ? 'Testa paziņojums nosūtīts. Tam jāparādās pēc brīža.'
        : gone ? 'Šīs ierīces reģistrācija vairs nav derīga. Izslēdziet un ieslēdziet paziņojumus šajā ierīcē.'
        : r.status === 0 ? `Serveris nevarēja sasniegt paziņojumu servisu${r.reason ? ` (${r.reason})` : ''}.`
        : `Paziņojumu serviss atteica (kods ${r.status}${r.reason ? `: ${r.reason}` : ''}). Servera kontakts: ${r.contact ?? '?'}`)
      if (!r.ok && (r.status === 404 || r.status === 410)) setEndpoint(null)
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Neizdevās nosūtīt')
    } finally { setBusy(false) }
  }

  // Notification hours apply at once, like the switches above. With no weekday chosen there is nothing valid
  // to save yet: keep it on screen (with a hint) and save as soon as a day is picked.
  const setSchedule = async (patch: Partial<PushSchedule>) => {
    if (!status || !endpoint) return
    const schedule = { ...(status.schedules[endpoint] ?? NO_HOURS), ...patch }
    setStatus({ ...status, schedules: { ...status.schedules, [endpoint]: schedule } })
    setNote('')
    if (schedule.enabled && schedule.days.length === 0) return
    if (!TIME.test(schedule.start) || !TIME.test(schedule.end)) return // a time field that is being cleared/typed
    try { await api.pushSchedule(endpoint, schedule) } catch (err) {
      setStatus(status)
      setNote(err instanceof Error ? err.message : 'Neizdevās saglabāt paziņojumu laiku')
    }
  }
  const blocked = support !== 'ok'
  // This device's hours; with its notifications off there are none, and the section below is locked.
  const locked = endpoint === null
  const schedule = !status ? null : locked ? NO_HOURS : status.schedules[endpoint] ?? NO_HOURS
  const toggleDay = (day: number) => {
    if (!schedule) return
    const days = schedule.days
    setSchedule({ days: days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b) })
  }
  return (
    <>
      <div className="fsec push">
        <div className="lab">Paziņojumi</div>
        <Toggle label="Paziņojumi šajā ierīcē" checked={endpoint !== null} disabled={blocked || !status || busy}
          hint={blocked ? WHY_NOT[support] : 'Katru ierīci ieslēdz atsevišķi'} onChange={toggleDevice} />
        {endpoint !== null && status && <>
          {KINDS.map((k) => (
            <Toggle key={k.key} label={k.label} hint={k.hint} checked={status.prefs[k.key]} onChange={(on) => setKind(k.key, on)} />
          ))}
          <button type="button" className="btn small push__test" disabled={busy} onClick={test}>Nosūtīt testa paziņojumu</button>
        </>}
        {note && <p className="fnote" role="status">{note}</p>}
      </div>

      {/* This device's hours. Locked (shown, but off and greyed) until notifications are on for this device. */}
      {schedule && (
        <div className={locked ? 'fsec push push--locked' : 'fsec push'}>
          <div className="lab">Paziņojumu laiks šajā ierīcē</div>
          <Toggle label="Tikai noteiktā laikā" checked={!locked && schedule.enabled} disabled={locked} onChange={(on) => setSchedule({ enabled: on })}
            hint={locked ? 'Vispirms ieslēdziet paziņojumus šajā ierīcē.'
              : 'Ārpus šī laika šajā ierīcē paziņojumi nepienāk. Ja problēma joprojām pastāv, kad laiks sākas, par to paziņo tad.'} />
          {!locked && schedule.enabled && <>
            <div className="frow">
              <label>No
                <input type="time" value={schedule.start} onChange={(e) => setSchedule({ start: e.target.value })} />
              </label>
              <label>Līdz
                <input type="time" value={schedule.end} onChange={(e) => setSchedule({ end: e.target.value })} />
              </label>
            </div>
            <div className="chips days" role="group" aria-label="Nedēļas dienas">
              {DAYS.map((d, i) => (
                <button key={d.short} type="button" className={schedule.days.includes(i) ? 'chip on' : 'chip'}
                  aria-pressed={schedule.days.includes(i)} aria-label={d.name} title={d.name} onClick={() => toggleDay(i)}>{d.short}</button>
              ))}
            </div>
            {schedule.days.length === 0
              ? <p className="fnote warn" role="status">Izvēlieties vismaz vienu dienu, citādi laiks netiek saglabāts.</p>
              : schedule.start > schedule.end
                ? <p className="fnote">Pāri pusnaktij: no {schedule.start} izvēlētajās dienās līdz {schedule.end} nākamajā rītā.</p>
                : schedule.start === schedule.end && <p className="fnote">Vienāds sākums un beigas: visu diennakti izvēlētajās dienās.</p>}
          </>}
        </div>
      )}
    </>
  )
}
