import { useState } from 'react'
import { api, fmtTime, type Empties, type EmptyKind, type EmptyLogItem, type EmptyRow, type StoreLocation } from '../../api'
import { useApiData } from '../../cache'
import { DotTile } from '../../components/ColorDot'
import { ConfirmDialog } from '../../components/Dialog'
import { Stepper } from '../../components/Stepper'
import { Segmented } from '../../components/Toggle'
import { ActionMenu } from '../../components/TonerRow'
import { Icon } from '../../icons'

const NONE: Empties = { rows: [], log: [] }
const KIND_LV: Record<EmptyKind, string> = { toner: 'Toneri', drum: 'Drumi' }
const KIND_OPTIONS = [{ value: 'toner', label: 'Toneri' }, { value: 'drum', label: 'Drumi' }]
const isCount = (s: string, min: number, max: number) => /^\d+$/.test(s.trim()) && +s >= min && +s <= max

type Dlg =
  | { kind: 'return'; row: EmptyRow }
  | { kind: 'move'; row: EmptyRow }
  | { kind: 'correct'; row: EmptyRow }
  | { kind: 'add' } // a count for a place/kind that has none yet (e.g. the first stock-take)
  | null

/** What one log line says. */
function logText(g: EmptyLogItem): string {
  const what = KIND_LV[g.kind].toLowerCase()
  if (g.reason === 'used') return `+${g.delta} ${what} · izlietots${g.note ? ` (${g.note})` : ''}`
  if (g.reason === 'returned') return `Atdots: ${-g.delta} ${what}${g.note ? ` · ${g.note}` : ''}`
  if (g.reason === 'moved') return `Pārvietots: ${g.delta} ${what} → ${g.to_location ?? '?'}`
  return `Labots: ${g.delta > 0 ? '+' : ''}${g.delta} ${what}${g.note ? ` · ${g.note}` : ''}`
}

/**
 * Vēsture → Tukšie: empty toners and drums waiting to be handed back to the supplier — how many of each kind
 * lie in each storage place (counted by kind, not by code). An empty arrives here when a cartridge is marked
 * "Izlietots". Per line: Atdot (handed back), Lokācija (moved to another place), Labot daudzumu (recount).
 */
export function EmptiesPanel() {
  const { data, setData, loading } = useApiData<Empties>('empties', api.empties, NONE)
  const locations = useApiData<StoreLocation[]>('locations', api.locations, [])
  const active = locations.data.filter((l) => l.active)
  const [dlg, setDlg] = useState<Dlg>(null)
  const [qtyText, setQtyText] = useState('1')
  const [note, setNote] = useState('')
  const [toId, setToId] = useState(0)
  const [addLoc, setAddLoc] = useState(0)
  const [addKind, setAddKind] = useState<EmptyKind>('toner')

  const open = (next: Dlg, qty: number) => {
    setQtyText(String(qty))
    setNote('')
    if (next?.kind === 'move') setToId(active.find((l) => l.id !== next.row.location_id)?.id ?? 0)
    if (next?.kind === 'add') { setAddLoc(active[0]?.id ?? 0); setAddKind('toner') }
    setDlg(next)
  }
  const total = (kind: EmptyKind) => data.rows.filter((r) => r.kind === kind).reduce((n, r) => n + r.qty, 0)
  const places = [...new Map(data.rows.map((r) => [r.location_id, r.location])).entries()]
  const qty = Number(qtyText)

  return (
    <section className="pane logpane">
      <div className="rh">
        <h3>Tukšie</h3>
        <div className="rh-tools">
          <span className="meta">toneri {total('toner')} · drumi {total('drum')}</span>
          <button className="btn small" onClick={() => open({ kind: 'add' }, 1)}>{Icon.plus(15)} Pievienot</button>
        </div>
      </div>
      <p className="mhint">Izlietotie toneri un drumi, kas gaida atdošanu piegādātājam. Skaitīti pa glabāšanas vietām un veidiem, ne pa kodiem.</p>
      {data.rows.length === 0 && <p className="muted empty">{loading ? 'Ielādē…' : 'Tukšo nav. Tie parādās, kad toneris vai drums tiek atzīmēts kā izlietots.'}</p>}

      {places.map(([locId, name]) => (
        <div key={locId} className="emp-loc">
          <div className="emp-loc__name">{name}</div>
          {data.rows.filter((r) => r.location_id === locId).map((r) => (
            <div key={r.kind} className="emp-row">
              <DotTile color="" kind={r.kind} />
              <span className="emp-row__kind">{KIND_LV[r.kind]}</span>
              <b className="pv">{r.qty}</b>
              <ActionMenu code={`${KIND_LV[r.kind]}, ${name}`} items={[
                { label: 'Atdot', run: () => open({ kind: 'return', row: r }, r.qty) },
                { label: 'Lokācija', run: () => open({ kind: 'move', row: r }, r.qty), disabled: active.filter((l) => l.id !== r.location_id).length === 0, divider: true },
                { label: 'Labot daudzumu', run: () => open({ kind: 'correct', row: r }, r.qty) },
              ]} />
            </div>
          ))}
        </div>
      ))}

      {data.log.length > 0 && <>
        <h3 className="lab emp-log__head">Pēdējās darbības</h3>
        <ul className="emp-log">
          {data.log.map((g) => (
            <li key={g.id}><span>{logText(g)}</span><small>{[g.location, g.username, fmtTime(g.ts)].filter(Boolean).join(' · ')}</small></li>
          ))}
        </ul>
      </>}

      {dlg?.kind === 'return' && (
        <ConfirmDialog title="Atdot piegādātājam" confirmLabel={isCount(qtyText, 1, dlg.row.qty) ? `Atdot ${qty}` : 'Atdot'}
          disabled={!isCount(qtyText, 1, dlg.row.qty)} onClose={() => setDlg(null)}
          onConfirm={async () => setData(await api.returnEmpties({ location_id: dlg.row.location_id, kind: dlg.row.kind, qty, note }))}>
          <p className="dlg-text"><b>{KIND_LV[dlg.row.kind]}</b> · {dlg.row.location}<br /><span className="muted">Tur ir {dlg.row.qty} tukšie.</span></p>
          <div className="field"><span>Cik atdod</span><Stepper label="Cik atdod" value={qtyText} onChange={setQtyText} min={1} max={dlg.row.qty} /></div>
          <label>Piezīme (nav obligāta)<input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" placeholder="piem. kam atdots…" /></label>
          {isCount(qtyText, 1, dlg.row.qty) && <p className="dlg-text muted">Paliks: {dlg.row.qty - qty}</p>}
        </ConfirmDialog>
      )}

      {dlg?.kind === 'move' && (
        <ConfirmDialog title="Lokācija: tukšie" confirmLabel="Pārvietot" disabled={!toId || !isCount(qtyText, 1, dlg.row.qty)} onClose={() => setDlg(null)}
          onConfirm={async () => setData(await api.moveEmpties({ from_location_id: dlg.row.location_id, to_location_id: toId, kind: dlg.row.kind, qty }))}>
          <p className="dlg-text"><b>{KIND_LV[dlg.row.kind]}</b> · no: {dlg.row.location} ({dlg.row.qty})</p>
          <label>Uz
            <select value={toId} onChange={(e) => setToId(+e.target.value)}>
              {active.filter((l) => l.id !== dlg.row.location_id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <div className="field"><span>Skaits</span><Stepper label="Skaits" value={qtyText} onChange={setQtyText} min={1} max={dlg.row.qty} /></div>
        </ConfirmDialog>
      )}

      {dlg?.kind === 'correct' && (
        <ConfirmDialog title="Labot daudzumu: tukšie" confirmLabel="Saglabāt" disabled={!isCount(qtyText, 0, 10000) || qty === dlg.row.qty} onClose={() => setDlg(null)}
          onConfirm={async () => setData(await api.correctEmpties({ location_id: dlg.row.location_id, kind: dlg.row.kind, qty, note }))}>
          <p className="dlg-text"><b>{KIND_LV[dlg.row.kind]}</b> · {dlg.row.location}<br /><span className="muted">Ierakstiet, cik tur ir patiesībā.</span></p>
          <div className="field"><span>Daudzums</span><Stepper label="Daudzums" value={qtyText} onChange={setQtyText} min={0} max={10000} /></div>
          <label>Piezīme (nav obligāta)<input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" /></label>
          {isCount(qtyText, 0, 10000) && qty !== dlg.row.qty && <p className="dlg-text">{dlg.row.qty} → <b>{qty}</b></p>}
        </ConfirmDialog>
      )}

      {dlg?.kind === 'add' && (
        <ConfirmDialog title="Pievienot tukšos" confirmLabel="Saglabāt" disabled={!addLoc || !isCount(qtyText, 1, 10000)} onClose={() => setDlg(null)}
          onConfirm={async () => {
            // "Pievienot" adds to what is already counted there (a recount of an existing line is "Labot daudzumu").
            const have = data.rows.find((r) => r.location_id === addLoc && r.kind === addKind)?.qty ?? 0
            setData(await api.correctEmpties({ location_id: addLoc, kind: addKind, qty: have + qty, note }))
          }}>
          <p className="dlg-text muted">Tukšajiem, kas jau ir uz vietas un nav uzskaitīti (piem., pirmā saskaitīšana).</p>
          <div className="field"><span>Veids</span><Segmented label="Veids" value={addKind} onChange={(k) => setAddKind(k as EmptyKind)} options={KIND_OPTIONS} /></div>
          <label>Vieta
            <select value={addLoc} onChange={(e) => setAddLoc(+e.target.value)}>
              {active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <div className="field"><span>Cik pievienot</span><Stepper label="Cik pievienot" value={qtyText} onChange={setQtyText} min={1} max={10000} /></div>
          <label>Piezīme (nav obligāta)<input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" /></label>
        </ConfirmDialog>
      )}
    </section>
  )
}
