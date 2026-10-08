import { useState } from 'react'
import { api, type Printer, type Toner } from '../../api'
import { Dialog, DestructiveDialog } from '../../components/Dialog'
import { Segmented } from '../../components/Toggle'
import { canAutoFocus } from '../../lib'

const COLORS = ['', 'K', 'C', 'M', 'Y']
const KINDS = [{ value: 'toner', label: 'Toneris' }, { value: 'drum', label: 'Drums' }, { value: 'other', label: 'Cits' }]

interface Props {
  toner: Toner | null // null = add a new toner code
  users: Printer[] // printers that use this toner (delete is only allowed when none)
  onClose: () => void
  onSaved: () => Promise<unknown>
}

/** Add / edit a toner code in the catalogue. */
export function TonerEditor({ toner, users, onClose, onSaved }: Props) {
  const [code, setCode] = useState(toner?.code ?? '')
  const [color, setColor] = useState(toner?.color ?? '')
  const [kind, setKind] = useState(toner?.kind ?? 'toner')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const save = async () => {
    const body = { code: code.trim(), color, kind }
    if (toner) await api.updateToner(toner.id, body)
    else await api.createToner(body)
    await onSaved()
  }

  return (
    <>
      <Dialog.Frame title={toner ? code || 'Toneris' : 'Jauns toneris'} onClose={onClose} onSubmit={save}>
        <label>Kods<input name="code" autoFocus={!toner && canAutoFocus()} autoComplete="off" spellCheck={false} autoCapitalize="characters"
          value={code} onChange={(e) => setCode(e.target.value)} placeholder="piem. CF360X…" /></label>
        <div className="field"><span>Krāsa</span>
          <Segmented label="Krāsa" value={color} onChange={setColor}
            options={COLORS.map((c) => ({ value: c, label: c ? <><i className={`cdot ${c.toLowerCase()}`} />{c}</> : '–' }))} />
        </div>
        <div className="field"><span>Veids</span>
          <Segmented label="Veids" value={kind} onChange={setKind} options={KINDS} />
        </div>
        {/* What the kind means for the app, so the colour is filled in right. */}
        {kind === 'drum' && <p className="fnote">Drums: lietotne rāda tā līmeni, pamana nomaiņu un brīdina, kad tas ir zems un rezervē nav neviena. Norādiet krāsu; ja vienu kodu lieto vairākām krāsām, krāsu atstājiet tukšu („–”).</p>}
        {kind === 'other' && <p className="fnote">Cits (piem., atkritumu tvertne): tikai uzskaitei rezervē un pasūtīšanai. Līmenim un nomaiņai lietotne neseko.</p>}
        {toner && (
          <p className="fnote">{users.length
            ? <>Izmanto: {users.map((p) => p.location).join(', ')}. Dzēst var tikai neizmantotu toneri.</>
            : 'Netiek izmantots nevienā printerī.'}</p>
        )}
        <Dialog.Footer>
          {toner && (
            <Dialog.Start>
              <button type="button" className="btn danger" disabled={users.length > 0}
                title={users.length ? 'Toneri vēl izmanto printeri' : undefined} onClick={() => setConfirmDelete(true)}>Dzēst</button>
            </Dialog.Start>
          )}
          <Dialog.Cancel />
          <Dialog.Confirm disabled={!code.trim()}>Saglabāt</Dialog.Confirm>
        </Dialog.Footer>
      </Dialog.Frame>

      {toner && confirmDelete && (
        <DestructiveDialog title="Dzēst toneri" confirmLabel="Dzēst" onClose={() => setConfirmDelete(false)}
          onConfirm={async () => { await api.deleteToner(toner.id); await onSaved(); onClose() }}>
          <p className="dlg-text">Dzēst toneru kodu „{toner.code}”?</p>
        </DestructiveDialog>
      )}
    </>
  )
}
