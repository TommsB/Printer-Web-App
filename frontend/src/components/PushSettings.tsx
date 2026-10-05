import { useEffect, useState } from 'react'
import { api, type PushPrefs, type PushStatus } from '../api'
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
  { key: 'replacement', label: 'Nomainīts toneris', hint: 'Jāapstiprina sadaļā Vēsture' },
  { key: 'toner', label: 'Beidzas toneris, rezerves nav', hint: 'Toneris zem 15% un rezervē nav neviena' },
]

/**
 * Profile window → Paziņojumi. "Šajā ierīcē" is per device (each phone/browser is switched on separately,
 * because the browser has to ask for permission there); the three kinds are per user, for all their devices.
 * Every switch applies at once.
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
      if (on) setEndpoint((await enablePush(status.public_key)).endpoint)
      else { await disablePush(); setEndpoint(null) }
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
      setNote(r.ok ? 'Testa paziņojums nosūtīts. Tam jāparādās pēc brīža.' : `Paziņojumu serviss to nepieņēma (kods ${r.status}). Izslēdziet un ieslēdziet paziņojumus šajā ierīcē.`)
      if (!r.ok && (r.status === 404 || r.status === 410)) setEndpoint(null)
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Neizdevās nosūtīt')
    } finally { setBusy(false) }
  }

  const blocked = support !== 'ok'
  return (
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
  )
}
