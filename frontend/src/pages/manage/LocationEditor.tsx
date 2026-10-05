import { useState } from 'react'
import { api, UNASSIGNED, type StoreLocation } from '../../api'
import { ConfirmDialog } from '../../components/Dialog'
import { Toggle } from '../../components/Toggle'
import { canAutoFocus } from '../../lib'

interface Props {
  location: StoreLocation | null // null = add a new storage place
  onClose: () => void
  onSaved: () => Promise<unknown>
}

/** Add / edit a storage place (glabāšanas vieta). Places are archived, never deleted. */
export function LocationEditor({ location, onClose, onSaved }: Props) {
  const [name, setName] = useState(location?.name ?? '')
  const [short, setShort] = useState(location?.short ?? '')
  const [active, setActive] = useState(location?.active ?? true)
  const inStock = location?.in_stock ?? 0
  const locked = !!location && location.active && inStock > 0 // can't archive while cartridges are there

  return (
    <ConfirmDialog title={location ? name || 'Glabāšanas vieta' : 'Jauna glabāšanas vieta'} confirmLabel="Saglabāt"
      disabled={!name.trim()} onClose={onClose}
      onConfirm={async () => {
        if (location) await api.updateLocation(location.id, name.trim(), short.trim(), active)
        else await api.createLocation(name.trim(), short.trim())
        await onSaved()
      }}>
      <label>Nosaukums<input name="name" autoFocus={!location && canAutoFocus()} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} placeholder="piem. SP Noliktava…" /></label>
      <label>Saīsinājums<input name="short" autoComplete="off" maxLength={20} value={short} onChange={(e) => setShort(e.target.value)} placeholder="piem. SP Nol.…" /></label>
      <p className="fnote">Tonera rindā Krājumos rādīs: <b>{short.trim() || name.trim() || '–'}</b></p>
      {location && (
        <Toggle label="Aktīva" checked={active} onChange={setActive} disabled={locked}
          hint={locked ? `Vietā ir ${inStock} gab. — lai arhivētu, vispirms pārvietojiet tos` : 'Arhivētu vietu nepiedāvā jaunām kasetnēm'} />
      )}
      {location?.name === UNASSIGNED && <p className="fnote">Šī vieta tika izveidota automātiski kasetnēm, kurām vieta vēl nav norādīta.</p>}
    </ConfirmDialog>
  )
}
