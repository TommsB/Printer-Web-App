import { useEffect, useRef, useState } from 'react'
import { api, fmtTime, orderFileUrl, type Order, type OrderFile, type StoreLocation } from '../api'
import { useApiData } from '../cache'
import { fmtSize, prepareFiles } from '../files'
import { Icon } from '../icons'
import { DEFECT_STATUS, fmtNum } from '../lib'
import { DestructiveDialog, Dialog } from './Dialog'
import { FileViewer } from './FileViewer'

const isImage = (mime: string) => /^image\/(jpeg|png|webp|gif)$/i.test(mime)

/** "Pievienot foto vai failus": a normal button over a hidden file input. On a phone it offers the camera,
 *  the photo library and the files app; several can be chosen at once. */
export function FilePicker({ onPick, disabled, label = 'Pievienot foto vai failus' }: { onPick: (files: File[]) => void; disabled?: boolean; label?: string }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" className="btn small" disabled={disabled} onClick={() => input.current?.click()}>{Icon.clip(15)} {label}</button>
      <input ref={input} type="file" multiple hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.eml,.msg"
        onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ''; if (list.length) onPick(list) }} />
    </>
  )
}

/** Files chosen in the "Defekts" form, before the record exists (they are uploaded right after it is created). */
export function PendingFiles({ files, onChange, label = 'Foto un faili (nav obligāti)', button }: {
  files: File[]; onChange: (files: File[]) => void; label?: string; button?: string
}) {
  return (
    <div className="field"><span>{label}</span>
      {files.length > 0 && (
        <ul className="flist">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span className="flist__name">{f.name}</span><small>{fmtSize(f.size)}</small>
              <button type="button" className="icon-btn" aria-label={`Noņemt ${f.name}`} title="Noņemt"
                onClick={() => onChange(files.filter((_, j) => j !== i))}>{Icon.close(15)}</button>
            </li>
          ))}
        </ul>
      )}
      <FilePicker onPick={(list) => onChange([...files, ...list])} label={button} />
    </div>
  )
}

/**
 * A defect's details: what was recorded, where the cartridge is kept (can be changed) and its photos/files
 * (add, open, delete). Everything applies at once, so the only button is "Aizvērt". `onChange` lets the list
 * behind it refresh its file count and place.
 */
export function DefectDialog({ order, onClose, onChange }: { order: Order; onClose: () => void; onChange: () => void }) {
  const locations = useApiData<StoreLocation[]>('locations', api.locations, [])
  const [files, setFiles] = useState<OrderFile[] | null>(null)
  const [held, setHeld] = useState(order.held_location_id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [viewing, setViewing] = useState<OrderFile | null>(null)

  useEffect(() => {
    let alive = true
    api.orderFiles(order.id).then((f) => { if (alive) setFiles(f) }).catch(() => { if (alive) setFiles([]) })
    return () => { alive = false }
  }, [order.id])

  const run = async (what: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await what(); onChange() } catch (err) { setError(err instanceof Error ? err.message : 'Kļūda') } finally { setBusy(false) }
  }
  const add = (picked: File[]) => run(async () => { setFiles(await api.uploadOrderFiles(order.id, await prepareFiles(picked))) })
  const [deleting, setDeleting] = useState<OrderFile | null>(null) // asked before a file is deleted
  const move = (id: number | null) => run(async () => { await api.setHeld(order.id, id); setHeld(id) })

  // The place it is kept in stays selectable even if that place was archived since.
  const places = locations.data.filter((l) => l.active || l.id === held)
  const images = (files ?? []).filter((f) => isImage(f.mime))
  const others = (files ?? []).filter((f) => !isImage(f.mime))

  return (
    <>
    <Dialog.Frame title={`Defekts: ${order.code}`} onClose={onClose} confirmDiscard={false}>
      <p className="dlg-text"><i className={`cdot ${order.color ? order.color.toLowerCase() : 'g'}`} /> <b>{order.code}</b> · {order.location}</p>
      <dl className="ddl">
        <dt>Defekts</dt><dd>{order.defect || '–'}</dd>
        <dt>Izņemts pie</dt><dd>{order.removed_pct == null ? 'nav zināms' : `${order.removed_pct}%`}</dd>
        <dt>Izdrukāts ar šo kasetni</dt>
        <dd>{order.pages_printed == null ? 'nav zināms' : `${fmtNum(order.pages_printed)} lapas`}
          {order.installed_ts && <small> · ielikta {fmtTime(order.installed_ts)}</small>}</dd>
        <dt>Statuss</dt><dd>{DEFECT_STATUS[order.status].label}</dd>
        <dt>Atzīmēja</dt><dd>{order.created_by} · {fmtTime(order.created_ts)}</dd>
        {order.sent_ts && <><dt>Nodots garantijā</dt><dd>{order.sent_by} · {fmtTime(order.sent_ts)}</dd></>}
        {order.resolved_ts && (order.status === 'received' || order.status === 'cancelled') && <>
          <dt>{order.status === 'received' ? 'Aizvietotājs saņemts' : 'Noraidīts'}</dt><dd>{order.resolved_by} · {fmtTime(order.resolved_ts)}</dd>
        </>}
        {order.note && <><dt>Piezīme</dt><dd>{order.note}</dd></>}
      </dl>
      {/* Only while we still have it: once handed over, where it was kept no longer matters. */}
      {order.status === 'defect' && (
        <label>Kur atrodas bojātā kasetne
          <select value={held ?? ''} disabled={busy} onChange={(e) => move(e.target.value ? +e.target.value : null)}>
            <option value="">– nav norādīts –</option>
            {places.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      )}

      <div className="field"><span>Foto un faili{files && files.length > 0 ? ` (${files.length})` : ''}</span>
        {files === null && <p className="muted">Ielādē…</p>}
        {files?.length === 0 && <p className="muted">Nav pievienotu failu.</p>}
        {images.length > 0 && (
          <ul className="fgrid">
            {images.map((f) => (
              <li key={f.id}>
                <button type="button" className="fgrid__open" title={`${f.name} · ${fmtSize(f.size)}`} onClick={() => setViewing(f)}>
                  <img src={orderFileUrl(f.id)} alt={f.name} loading="lazy" width={96} height={96} />
                </button>
                <button type="button" className="fgrid__del" disabled={busy} aria-label={`Dzēst ${f.name}`} title="Dzēst" onClick={() => setDeleting(f)}>{Icon.close(13)}</button>
              </li>
            ))}
          </ul>
        )}
        {others.length > 0 && (
          <ul className="flist">
            {others.map((f) => (
              <li key={f.id}>
                <button type="button" className="flist__name" onClick={() => setViewing(f)}>{f.name}</button><small>{fmtSize(f.size)}</small>
                <button type="button" className="icon-btn" disabled={busy} aria-label={`Dzēst ${f.name}`} title="Dzēst" onClick={() => setDeleting(f)}>{Icon.trash(15)}</button>
              </li>
            ))}
          </ul>
        )}
        <FilePicker onPick={add} disabled={busy} label={busy ? 'Saglabā…' : 'Pievienot foto vai failus'} />
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {/* Opened inside the app (not as a page of its own, which the home-screen app can't get back from). */}
      {viewing && <FileViewer file={{ url: orderFileUrl(viewing.id), name: viewing.name, mime: viewing.mime }} onClose={() => setViewing(null)} />}
      <Dialog.Footer>
        <Dialog.Cancel>Aizvērt</Dialog.Cancel>
      </Dialog.Footer>
    </Dialog.Frame>
    {deleting && (
      <DestructiveDialog title="Dzēst failu" confirmLabel="Dzēst" onClose={() => setDeleting(null)}
        onConfirm={async () => { await api.deleteOrderFile(deleting.id); setFiles((l) => (l ?? []).filter((x) => x.id !== deleting.id)); onChange() }}>
        <p className="dlg-text">Dzēst <b>{deleting.name}</b>? To nevar atsaukt.</p>
      </DestructiveDialog>
    )}
    </>
  )
}
