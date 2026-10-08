import { useState } from 'react'
import { api, type Printer, type PrinterInput, type SnmpTest, type StoreLocation, type Toner } from '../../api'
import { classifySupply, fmtNum, supplyCode } from '../../lib'
import { Dialog, DestructiveDialog } from '../../components/Dialog'
import { Stepper } from '../../components/Stepper'
import { Segmented, Toggle } from '../../components/Toggle'
import { useApp } from '../../ctx'
import { Icon } from '../../icons'
import { CDot } from '../../components/ColorDot'

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const ADD_KINDS = [{ value: 'toner', label: 'Toneri' }, { value: 'drum', label: 'Drumu' }, { value: 'other', label: 'Citu' }]
const ADD_WHAT: Record<string, string> = { toner: 'toneris', drum: 'drums', other: 'cits' }
const kindRank = (kind: string) => (kind === 'toner' ? 0 : kind === 'drum' ? 1 : 2)
const colorRank = (color: string) => { const i = ['K', 'C', 'M', 'Y', 'CMY'].indexOf(color.toUpperCase()); return i < 0 ? 9 : i }
/** A code's "family": the letters it starts with ("CF361X" → "CF", "TN-221K" → "TN"). Codes of one printer
 *  model nearly always share it, so it is what "similar to the ones already added" goes by. */
const family = (code: string) => (/^[A-Za-z]{2,}/.exec(code.trim())?.[0] ?? '').toUpperCase()
const commonPrefix = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i].toUpperCase() === b[i].toUpperCase()) i++; return i }
const EMPTY: PrinterInput = {
  company: '', location: '', model: '', brand: '', ip: '', color_type: 'Krāsains',
  snmp_enabled: true, active: true, notes: '', toner_ids: [], norms: {}, default_location_id: null, empties_location_id: null,
}

function toForm(p: Printer): PrinterInput {
  return {
    company: p.company, location: p.location, model: p.model, brand: p.brand, ip: p.ip ?? '', color_type: p.color_type,
    snmp_enabled: p.snmp_enabled, active: p.active, notes: p.notes, default_location_id: p.default_location_id, empties_location_id: p.empties_location_id,
    toner_ids: p.toners.map((t) => t.id), norms: Object.fromEntries(p.toners.map((t) => [t.id, t.optimal_qty])),
  }
}

type TestState =
  | { state: 'idle' | 'running' }
  | { state: 'done'; ip: string; result: SnmpTest }
  | { state: 'error'; message: string }

/** Outcome of "Pārbaudīt savienojumu": what the printer reported, or why it didn't answer. Read out when it appears. */
function SnmpTestResult({ test }: { test: TestState }) {
  if (test.state === 'error') return <p className="snmp-test bad" role="status">Pārbaude neizdevās: {test.message}</p>
  if (test.state !== 'done') return null
  const r = test.result
  if (!r.reachable) {
    return (
      <p className="snmp-test bad" role="status">
        <b>{test.ip} neatbild uz SNMP.</b> Pārbaudiet IP adresi, vai printeris ir ieslēgts un vai tajā ir atļauts SNMP (v2c).
      </p>
    )
  }
  return <TestOk result={r} />
}

/** Success: just "Savienojums izdevās", tap to see what the printer reported. Remounts per test, so it starts collapsed. */
function TestOk({ result: r }: { result: Extract<SnmpTest, { reachable: true }> }) {
  const [open, setOpen] = useState(false)
  const levels = r.supplies.filter((s) => s.pct !== null)
  return (
    <div className="snmp-test ok" role="status">
      <button type="button" className="snmp-test__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <b>Savienojums izdevās</b>
        <span className={open ? 'fold-ic open' : 'fold-ic'}>{Icon.chevron(16)}</span>
      </button>
      {open && <>
      <dl>
        {r.description && <><dt>Ierīce</dt><dd>{r.description}</dd></>}
        {r.hostname && <><dt>Nosaukums</dt><dd>{r.hostname}</dd></>}
        {r.serial && <><dt>Sērijas nr.</dt><dd>{r.serial}</dd></>}
        {r.page_count !== null && <><dt>Lapas kopā</dt><dd>{fmtNum(r.page_count)}</dd></>}
        {levels.length === 0 && <><dt>Izejmateriāli</dt><dd>Printeris neziņo līmeņus</dd></>}
      </dl>
      {levels.length > 0 && (
        <ul className="snmp-test__sup" aria-label="Izejmateriāli">
          {levels.map((s, i) => (
            <li key={i}><span>{s.description.replace(/\.$/, '')}</span><b>{s.pct}%</b></li>
          ))}
        </ul>
      )}
      </>}
    </div>
  )
}

/** "Dublēt": a new printer that starts as a copy of another — everything that printers of the same model
 *  share. Its own name, IP address, notes and reserve are not copied (the reserve starts at 0). */
function copyOf(p: Printer): PrinterInput {
  return { ...toForm(p), location: '', ip: '', notes: '', active: true }
}

interface Props {
  printer: Printer | null // null = add a new printer
  template?: Printer | null // a new printer started with "Dublēt" from this one
  onDuplicate?: (p: Printer) => void
  toners: Toner[]
  onCatalogueChange?: () => void // a new code was added to the catalogue from here
  locations: StoreLocation[]
  onClose: () => void
  onSaved: () => Promise<unknown>
}

/** A toner or drum the printer reports by code: what it is, and the catalogue entry if that code exists. */
interface Reported { code: string; kind: 'toner' | 'drum'; color: string; existing?: Toner }

/** Add / edit a printer: details, network, linked components with norms, default storage place. */
export function PrinterEditor({ printer, template, onDuplicate, toners: catalogue, onCatalogueChange, locations, onClose, onSaved }: Props) {
  const { companies } = useApp()
  const [form, setForm] = useState<PrinterInput>(() => (printer ? toForm(printer) : template ? copyOf(template) : { ...EMPTY }))
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = <K extends keyof PrinterInput>(k: K, v: PrinterInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  // No IP is allowed: a printer that isn't on the network, kept only for its toner reserve.
  const noIp = form.ip.trim() === ''
  const ipOk = IP_RE.test(form.ip.trim())
  const valid = form.location.trim() !== '' && (noIp || ipOk)
  // The catalogue, plus codes created from this window ("Printeris ziņo…") before the list behind it reloads.
  const [created, setCreated] = useState<Toner[]>([])
  const toners = [...catalogue, ...created.filter((c) => !catalogue.some((t) => t.id === c.id))]
  const linked = toners.filter((t) => form.toner_ids.includes(t.id))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || colorRank(a.color) - colorRank(b.color) || a.code.localeCompare(b.code))
  const unlinked = toners.filter((t) => !form.toner_ids.includes(t.id))
  const link = (...ids: number[]) => setForm((f) => ({
    ...f, toner_ids: [...f.toner_ids, ...ids.filter((id) => !f.toner_ids.includes(id))],
    norms: { ...f.norms, ...Object.fromEntries(ids.map((id) => [id, f.norms[id] ?? 1])) },
  }))
  // What can be added, of the chosen kind: the codes that look like the ones already linked first;
  // typing in the search box narrows both groups.
  const [addKind, setAddKind] = useState('toner')
  const [addQuery, setAddQuery] = useState('')
  const choices = unlinked.filter((t) => t.kind === addKind)
  const families = new Set(linked.map((t) => family(t.code)).filter(Boolean))
  const closeness = (code: string) => Math.max(0, ...linked.map((t) => commonPrefix(t.code, code)))
  const similar = choices.filter((t) => families.has(family(t.code)))
    .sort((a, b) => closeness(b.code) - closeness(a.code) || a.code.localeCompare(b.code))
  const rest = choices.filter((t) => !families.has(family(t.code)))
  const squash = (s: string) => s.toLowerCase().replace(/[\s-]/g, '') // "ck 8511" finds "CK-8511C"
  const hit = (t: Toner) => squash(t.code).includes(squash(addQuery))
  const foundSimilar = similar.filter(hit)
  const foundRest = rest.filter(hit)
  const found = [...foundSimilar, ...foundRest]
  const pickRow = (t: Toner) => (
    <li key={t.id}>
      <button type="button" onClick={() => link(t.id)}><CDot color={t.color} kind={t.kind} /><b>{t.code}</b>{t.color && <small>{t.color}</small>}</button>
    </li>
  )

  const [test, setTest] = useState<TestState>({ state: 'idle' })
  // "Atrast automātiski (SNMP)": ask the printer now what it has in it, and offer the toners and drums it
  // names with a code that aren't linked here yet. Only on that button — nothing is suggested by itself.
  const [scan, setScan] = useState<{ state: 'idle' | 'running' } | { state: 'done'; result: SnmpTest } | { state: 'error'; message: string }>({ state: 'idle' })
  const runScan = async () => {
    setScan({ state: 'running' })
    setAdoptError('')
    try { setScan({ state: 'done', result: await api.testSnmp(form.ip.trim()) }) }
    catch (err) { setScan({ state: 'error', message: err instanceof Error ? err.message : 'Kļūda' }) }
  }
  const supplies = scan.state === 'done' && scan.result.reachable ? scan.result.supplies : []
  const linkedCodes = new Set(linked.map((t) => t.code.toUpperCase()))
  const reported: Reported[] = []
  for (const s of supplies) {
    const what = classifySupply(s.description, form.color_type === 'Melnbalts')
    const code = supplyCode(s.description)
    if (!what || !code || linkedCodes.has(code) || reported.some((r) => r.code === code)) continue
    reported.push({ code, ...what, existing: toners.find((t) => t.code.toUpperCase() === code) })
  }
  const [adopting, setAdopting] = useState(false)
  const [adoptError, setAdoptError] = useState('')
  const adopt = async (list: Reported[]) => {
    setAdopting(true)
    setAdoptError('')
    try {
      const ids: number[] = []
      for (const r of list) {
        if (r.existing) { ids.push(r.existing.id); continue }
        const made = await api.createToner({ code: r.code, color: r.color, kind: r.kind })
        setCreated((c) => [...c, made])
        ids.push(made.id)
      }
      link(...ids)
      if (list.some((r) => !r.existing)) onCatalogueChange?.()
    } catch (err) { setAdoptError(err instanceof Error ? err.message : 'Neizdevās pievienot') } finally { setAdopting(false) }
  }
  const runTest = async () => {
    const ip = form.ip.trim()
    setTest({ state: 'running' })
    try {
      const result = await api.testSnmp(ip)
      // Ignore a late answer if the IP was edited meanwhile.
      setTest((t) => (t.state === 'running' ? { state: 'done', ip, result } : t))
    } catch (err) {
      setTest({ state: 'error', message: err instanceof Error ? err.message : 'Kļūda' })
    }
  }

  const save = async () => {
    const body = { ...form, location: form.location.trim(), ip: form.ip.trim() }
    if (printer) await api.updatePrinter(printer.id, body)
    else await api.createPrinter(body)
    await onSaved()
  }

  return (
    <>
      <Dialog.Frame className="wide" title={printer ? form.location || 'Printeris' : 'Jauns printeris'} onClose={onClose} onSubmit={save}>
        {!printer && template && (
          <p className="fnote">Kopija no „{template.location}”: modelis, toneri, normas un glabāšanas vieta. Ievadiet nosaukumu un, ja ir, IP adresi. Rezerve sākas no 0.</p>
        )}
        <div className="fsec">
          <div className="lab">Pamatinformācija</div>
          <label>Nosaukums (atrašanās vieta)<input name="location" autoComplete="off" value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="piem. TXP Main birojs…" /></label>
          <div className="frow">
            <label>Modelis<input name="model" autoComplete="off" spellCheck={false} value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="piem. HP MFP M577…" /></label>
            <label>Ražotājs<input name="brand" autoComplete="off" spellCheck={false} value={form.brand} onChange={(e) => set('brand', e.target.value)} placeholder="piem. HP…" /></label>
          </div>
          <div className="field"><span>Uzņēmums</span>
            <Segmented label="Uzņēmums" value={form.company} onChange={(v) => set('company', v)}
              options={[{ value: '', label: '–' }, ...companies.map((c) => ({ value: c, label: c }))]} />
          </div>
          <div className="field"><span>Tips</span>
            <Segmented label="Tips" value={form.color_type} onChange={(v) => set('color_type', v)}
              options={[{ value: 'Krāsains', label: 'Krāsains' }, { value: 'Melnbalts', label: 'Melnbalts' }]} />
          </div>
        </div>

        <div className="fsec">
          <div className="lab">Tīkls</div>
          <div className="ip-row">
            <label>IP adrese (nav obligāta)<input name="ip" autoComplete="off" spellCheck={false} value={form.ip} inputMode="decimal"
              onChange={(e) => { set('ip', e.target.value); setTest({ state: 'idle' }) }} placeholder="piem. 192.168.0.10…" /></label>
            <button type="button" className={test.state === 'running' ? 'btn small test-btn spin' : 'btn small test-btn'}
              disabled={!ipOk || test.state === 'running'} onClick={runTest}>
              {Icon.refresh(15)}{test.state === 'running' ? 'Pārbauda…' : 'Pārbaudīt savienojumu'}
            </button>
          </div>
          {!noIp && !ipOk && <span className="error">IP adresei jābūt formā 192.168.0.10</span>}
          {noIp && <p className="fnote">Bez IP adreses printeris netiek aptaujāts. Lietotnē tiek uzskaitīta tikai tā toneru rezerve.</p>}
          <SnmpTestResult test={test} />
          <Toggle label="SNMP aptauja" hint={noIp ? 'Nav iespējama bez IP adreses' : 'Nolasīt statusu un toneru līmeņus ik pēc 15 min'}
            checked={!noIp && form.snmp_enabled} disabled={noIp} onChange={(v) => set('snmp_enabled', v)} />
        </div>

        <div className="fsec">
          <div className="lab">Komponenti un normas</div>
          {linked.length === 0 && <p className="muted" style={{ margin: 0 }}>Nav piesaistītu komponentu.</p>}
          {linked.map((t) => (
            <div key={t.id} className="lrow">
              <CDot color={t.color} kind={t.kind} />
              <b>{t.code}</b>
              <span className="lrow__norm">norma</span>
              <Stepper label={`Norma ${t.code}`} value={String(form.norms[t.id] ?? 0)} min={0} max={99}
                onChange={(v) => set('norms', { ...form.norms, [t.id]: Math.min(99, Math.max(0, Math.floor(Number(v) || 0))) })} />
              <button type="button" className="icon-btn" aria-label={`Noņemt ${t.code}`} title="Noņemt"
                onClick={() => set('toner_ids', form.toner_ids.filter((x) => x !== t.id))}>{Icon.close(16)}</button>
            </div>
          ))}
          {/* Adding. Top row: what to add by hand (toner / drum / other) and, on the right, the button that
              asks the printer itself. Below: the printer's answer, then the search list for adding by hand. */}
          <div className="addc">
            <div className="field"><span>Pievienot komponentu</span>
              <div className="addc__top">
                <Segmented label="Pievienojamā komponenta veids" value={addKind} onChange={(k) => { setAddKind(k); setAddQuery('') }} options={ADD_KINDS} />
                <button type="button" className={scan.state === 'running' ? 'btn small test-btn spin' : 'btn small test-btn'}
                  disabled={!ipOk || scan.state === 'running'} onClick={runScan}
                  title={ipOk ? 'Nolasīt no printera tā tonerus un drumus un piedāvāt tos pievienot' : 'Vajadzīga printera IP adrese'}>
                  {Icon.refresh(15)}{scan.state === 'running' ? 'Meklē…' : 'Atrast automātiski (SNMP)'}
                </button>
              </div>
            </div>
            {scan.state === 'error' && <p className="snmp-test bad" role="status">Neizdevās nolasīt: {scan.message}</p>}
            {scan.state === 'done' && !scan.result.reachable && (
              <p className="snmp-test bad" role="status">Printeris neatbild uz SNMP. Pārbaudiet IP adresi un vai printeris ir ieslēgts.</p>
            )}
            {scan.state === 'done' && scan.result.reachable && reported.length === 0 && (
              <p className="fnote" role="status">Nekas jauns nav atrasts: printeris savus tonerus un drumus neziņo ar kodu, vai arī tie visi jau ir piesaistīti. Pievienojiet tos zemāk ar meklēšanu.</p>
            )}
          {/* What the printer reports and isn't linked here yet: one tap links it, creating the catalogue
              entry if the code is new. */}
          {reported.length > 0 && (
            <div className="sugg">
              <div className="sugg__head">Printeris ziņo par komponentiem, kas šeit nav piesaistīti</div>
              {reported.map((r) => (
                <div key={r.code} className="sugg__row">
                  <CDot color={r.color} kind={r.kind} />
                  <b>{r.code}</b>
                  <small>{r.existing ? 'ir katalogā' : `jauns kods · ${ADD_WHAT[r.kind]}${r.color ? `, ${r.color}` : ''}`}</small>
                  <button type="button" className="btn small" disabled={adopting} onClick={() => adopt([r])}>Pievienot</button>
                </div>
              ))}
              {reported.length > 1 && (
                <button type="button" className="btn small sugg__all" disabled={adopting} onClick={() => adopt(reported)}>Pievienot visus ({reported.length})</button>
              )}
              {reported.some((r) => !r.existing) && <p className="fnote">Jauns kods uzreiz tiek pievienots katalogam (Pārvaldība → Komponenti); printerim tas tiek piesaistīts, kad saglabājat.</p>}
              {adoptError && <span className="error" role="alert">{adoptError}</span>}
            </div>
          )}
          {/* Adding by hand: the code of the chosen kind — type a few characters to narrow the list. Codes like
              the ones already on this printer (same letters in front, e.g. "CF…") come first, so the rest of a
              set is easy to find. */}
              {choices.length === 0
                ? <p className="muted" style={{ margin: 0 }}>Šāda veida nepiesaistītu kodu katalogā nav. Jaunu kodu pievieno sadaļā Pārvaldība → Komponenti.</p>
                : <>
                    <input className="pick__q" type="search" autoComplete="off" spellCheck={false} value={addQuery}
                      aria-label={`Meklēt kodu: ${ADD_WHAT[addKind]}`} placeholder={`Meklēt kodu (${ADD_WHAT[addKind]})…`}
                      onChange={(e) => setAddQuery(e.target.value)}
                      // Enter picks the first match (and must not save the whole printer form).
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const first = found[0]; if (first && addQuery.trim()) { link(first.id); setAddQuery('') } } }} />
                    <ul className="pick" aria-label={`Kodi: ${ADD_WHAT[addKind]}`}>
                      {found.length === 0 && <li className="pick__none">Nekas neatbilst „{addQuery.trim()}”.</li>}
                      {foundSimilar.length > 0 && <li className="pick__h">Līdzīgi šim printerim</li>}
                      {foundSimilar.map(pickRow)}
                      {foundSimilar.length > 0 && foundRest.length > 0 && <li className="pick__h">Pārējie</li>}
                      {foundRest.map(pickRow)}
                    </ul>
                  </>}
          </div>
          {printer && <p className="fnote">Noņemot komponentu, tiek dzēsta arī šī printera rezerve tam.</p>}
        </div>

        <div className="fsec">
          <div className="lab">Krājumi</div>
          <label>Noklusētā glabāšanas vieta (kur novietot saņemtās kasetnes)
            <select value={form.default_location_id ?? ''} onChange={(e) => set('default_location_id', e.target.value ? +e.target.value : null)}>
              <option value="">– nav –</option>
              {locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label>Noklusētā vieta tukšajiem (kur novietot izlietotos tonerus un drumus)
            <select value={form.empties_location_id ?? ''} onChange={(e) => set('empties_location_id', e.target.value ? +e.target.value : null)}>
              <option value="">– nav –</option>
              {locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <p className="fnote">Atzīmējot toneri vai drumu kā izlietotu, šī vieta jau būs izvēlēta; tukšos uzskaita Vēsture → Tukšie.</p>
        </div>

        <div className="fsec">
          <div className="lab">Cits</div>
          <label>Piezīmes<textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
          <Toggle label="Aktīvs" hint="Neaktīvi printeri netiek rādīti statusā un netiek aptaujāti" checked={form.active} onChange={(v) => set('active', v)} />
        </div>

        <Dialog.Footer>
          {printer && (
            <Dialog.Start>
              <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>Dzēst</button>
              {/* Starts from the saved printer, not from unsaved edits in this form. */}
              {onDuplicate && <button type="button" className="btn" title="Jauns printeris ar tādu pašu modeli, toneriem un normām"
                onClick={() => onDuplicate(printer)}>Dublēt</button>}
            </Dialog.Start>
          )}
          <Dialog.Cancel />
          <Dialog.Confirm disabled={!valid}>Saglabāt</Dialog.Confirm>
        </Dialog.Footer>
      </Dialog.Frame>

      {printer && confirmDelete && (
        <DestructiveDialog title="Dzēst printeri" confirmLabel="Dzēst" onClose={() => setConfirmDelete(false)}
          onConfirm={async () => { await api.deletePrinter(printer.id); await onSaved(); onClose() }}>
          <p className="dlg-text">Dzēst „{printer.location}” kopā ar tā toneru rezervi un vēsturi? To nevar atsaukt. Ja printeris tikai vairs netiek lietots, labāk izslēdziet „Aktīvs”.</p>
        </DestructiveDialog>
      )}
    </>
  )
}
