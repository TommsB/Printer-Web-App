import { useState } from 'react'
import { api, type Printer, type Toner } from '../../api'
import { CDot } from '../../components/ColorDot'
import { Dialog, DestructiveDialog } from '../../components/Dialog'
import { Segmented } from '../../components/Toggle'
import { canAutoFocus } from '../../lib'

const COLORS = ['', 'K', 'C', 'M', 'Y']
const SHARED = 'CMY' // drums only: one code used for the cyan, magenta and yellow drum
const KINDS = [{ value: 'toner', label: 'Toneris' }, { value: 'drum', label: 'Drums' }, { value: 'other', label: 'Cits' }]

interface Props {
  toner: Toner | null // null = add a new code
  users: Printer[] // printers that use this component (delete is only allowed when none)
  onClose: () => void
  onSaved: () => Promise<unknown>
}

/** Add / edit a component code in the catalogue (Pārvaldība → Komponenti): a toner, a drum, or something else. */
export function TonerEditor({ toner, users, onClose, onSaved }: Props) {
  const [code, setCode] = useState(toner?.code ?? '')
  const [color, setColor] = useState((toner?.color ?? '').toUpperCase())
  const [kind, setKind] = useState(toner?.kind ?? 'toner')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const pickKind = (k: string) => {
    setKind(k)
    if (k !== 'drum' && color === SHARED) setColor('') // "CMY" only exists for drums
  }
  const save = async () => {
    const body = { code: code.trim(), color, kind }
    if (toner) await api.updateToner(toner.id, body)
    else await api.createToner(body)
    await onSaved()
  }
  const colors = kind === 'drum' ? [...COLORS, SHARED] : COLORS

  return (
    <>
      <Dialog.Frame title={toner ? code || 'Komponents' : 'Jauns komponents'} onClose={onClose} onSubmit={save}>
        <div className="field"><span>Veids</span>
          <Segmented label="Veids" value={kind} onChange={pickKind} options={KINDS} />
        </div>
        <label>Kods<input name="code" autoFocus={!toner && canAutoFocus()} autoComplete="off" spellCheck={false} autoCapitalize="characters"
          value={code} onChange={(e) => setCode(e.target.value)} placeholder={kind === 'drum' ? 'piem. CF358A…' : 'piem. CF360X…'} /></label>
        <div className="field"><span>Krāsa</span>
          <Segmented label="Krāsa" value={color} onChange={setColor}
            options={colors.map((c) => ({ value: c, label: c ? <><CDot color={c} kind={kind} />{c}</> : '–' }))} />
        </div>
        {/* What the kind means for the app, so the colour is filled in right. */}
        {kind === 'drum' && <p className="fnote">Drums: lietotne rāda tā līmeni, pamana nomaiņu un brīdina, kad tas ir zems un rezervē nav neviena. Norādiet krāsu. „CMY” — viens kods visiem trim krāsu drumiem (ciāna, purpura un dzeltenajam), piem. „DR-316 Color”.</p>}
        {kind === 'other' && <p className="fnote">Cits (piem., atkritumu tvertne): tikai uzskaitei rezervē un pasūtīšanai. Līmenim un nomaiņai lietotne neseko.</p>}
        {toner && (
          <p className="fnote">{users.length
            ? <>Izmanto: {users.map((p) => p.location).join(', ')}. Dzēst var tikai neizmantotu komponentu.</>
            : 'Netiek izmantots nevienā printerī.'}</p>
        )}
        <Dialog.Footer>
          {toner && (
            <Dialog.Start>
              <button type="button" className="btn danger" disabled={users.length > 0}
                title={users.length ? 'Komponentu vēl izmanto printeri' : undefined} onClick={() => setConfirmDelete(true)}>Dzēst</button>
            </Dialog.Start>
          )}
          <Dialog.Cancel />
          <Dialog.Confirm disabled={!code.trim()}>Saglabāt</Dialog.Confirm>
        </Dialog.Footer>
      </Dialog.Frame>

      {toner && confirmDelete && (
        <DestructiveDialog title="Dzēst komponentu" confirmLabel="Dzēst" onClose={() => setConfirmDelete(false)}
          onConfirm={async () => { await api.deleteToner(toner.id); await onSaved(); onClose() }}>
          <p className="dlg-text">Dzēst kodu „{toner.code}”?</p>
        </DestructiveDialog>
      )}
    </>
  )
}
