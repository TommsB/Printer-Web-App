import { useState } from 'react'
import { api, type Printer, type PrinterInput, type SnmpTest, type StoreLocation, type Toner } from '../../api'
import { fmtNum } from '../../lib'
import { Dialog, DestructiveDialog } from '../../components/Dialog'
import { Stepper } from '../../components/Stepper'
import { Segmented, Toggle } from '../../components/Toggle'
import { useApp } from '../../ctx'
import { Icon } from '../../icons'

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const EMPTY: PrinterInput = {
  company: '', location: '', model: '', brand: '', ip: '', color_type: 'Krāsains',
  snmp_enabled: true, active: true, notes: '', toner_ids: [], norms: {}, default_location_id: null,
}

function toForm(p: Printer): PrinterInput {
  return {
    company: p.company, location: p.location, model: p.model, brand: p.brand, ip: p.ip ?? '', color_type: p.color_type,
    snmp_enabled: p.snmp_enabled, active: p.active, notes: p.notes, default_location_id: p.default_location_id,
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
  locations: StoreLocation[]
  onClose: () => void
  onSaved: () => Promise<unknown>
}

/** Add / edit a printer: details, network, linked toners with norms, default storage place. */
export function PrinterEditor({ printer, template, onDuplicate, toners, locations, onClose, onSaved }: Props) {
  const { companies } = useApp()
  const [form, setForm] = useState<PrinterInput>(() => (printer ? toForm(printer) : template ? copyOf(template) : { ...EMPTY }))
  const [addToner, setAddToner] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = <K extends keyof PrinterInput>(k: K, v: PrinterInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  // No IP is allowed: a printer that isn't on the network, kept only for its toner reserve.
  const noIp = form.ip.trim() === ''
  const ipOk = IP_RE.test(form.ip.trim())
  const valid = form.location.trim() !== '' && (noIp || ipOk)
  const linked = toners.filter((t) => form.toner_ids.includes(t.id))
  const unlinked = toners.filter((t) => !form.toner_ids.includes(t.id))

  const [test, setTest] = useState<TestState>({ state: 'idle' })
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
          <div className="lab">Toneri un normas</div>
          {linked.length === 0 && <p className="muted" style={{ margin: 0 }}>Nav piesaistītu toneru.</p>}
          {linked.map((t) => (
            <div key={t.id} className="lrow">
              <i className={`cdot ${t.color ? t.color.toLowerCase() : 'g'}`} />
              <b>{t.code}</b>
              <span className="lrow__norm">norma</span>
              <Stepper label={`Norma ${t.code}`} value={String(form.norms[t.id] ?? 0)} min={0} max={99}
                onChange={(v) => set('norms', { ...form.norms, [t.id]: Math.min(99, Math.max(0, Math.floor(Number(v) || 0))) })} />
              <button type="button" className="icon-btn" aria-label={`Noņemt ${t.code}`} title="Noņemt"
                onClick={() => set('toner_ids', form.toner_ids.filter((x) => x !== t.id))}>{Icon.close(16)}</button>
            </div>
          ))}
          {unlinked.length > 0 && (
            <div className="counts__add">
              <select value={addToner} onChange={(e) => setAddToner(+e.target.value)} aria-label="Pievienot toneri">
                <option value={0}>+ Pievienot toneri…</option>
                {unlinked.map((t) => <option key={t.id} value={t.id}>{t.code}{t.color ? ` (${t.color})` : ''}</option>)}
              </select>
              <button type="button" className="btn small" disabled={!addToner} onClick={() => {
                setForm((f) => ({ ...f, toner_ids: [...f.toner_ids, addToner], norms: { ...f.norms, [addToner]: f.norms[addToner] ?? 1 } }))
                setAddToner(0)
              }}>Pievienot</button>
            </div>
          )}
          {printer && <p className="fnote">Noņemot toneri, tiek dzēsta arī šī printera rezerve tam.</p>}
        </div>

        <div className="fsec">
          <div className="lab">Krājumi</div>
          <label>Noklusētā glabāšanas vieta (kur novietot saņemtās kasetnes)
            <select value={form.default_location_id ?? ''} onChange={(e) => set('default_location_id', e.target.value ? +e.target.value : null)}>
              <option value="">– nav –</option>
              {locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
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
