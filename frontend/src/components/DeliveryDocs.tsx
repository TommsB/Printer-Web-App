import { useState } from 'react'
import { api, deliveryDocUrl, type DeliveryDoc, type Order } from '../api'
import { docsOf, fmtSize, prepareFiles } from '../files'
import { Icon } from '../icons'
import { FilePicker } from './DefectFiles'
import { DestructiveDialog, Dialog } from './Dialog'
import { FileViewer } from './FileViewer'

/**
 * Delivery notes ("pavadzīmes") of one company's orders from one day: open, add, delete. A document added
 * here is linked to all of those orders. Everything applies at once, so the only button is "Aizvērt";
 * `onChange` lets the list behind refresh.
 */
export function DeliveryDocsDialog({ title, orders, onClose, onChange }: {
  title: string // e.g. "Tenax · 06.10.2026."
  orders: Order[]
  onClose: () => void
  onChange: () => void
}) {
  const [docs, setDocs] = useState(() => docsOf(orders))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [viewing, setViewing] = useState<DeliveryDoc | null>(null)
  const run = async (what: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await what(); onChange() } catch (err) { setError(err instanceof Error ? err.message : 'Kļūda') } finally { setBusy(false) }
  }
  const add = (picked: File[]) => run(async () => {
    const added = await api.uploadDeliveryDocs(orders.map((o) => o.id), await prepareFiles(picked))
    setDocs((l) => [...l, ...added])
  })
  const [deleting, setDeleting] = useState<DeliveryDoc | null>(null) // asked before a document is deleted

  return (
    <>
    <Dialog.Frame title="Dokumenti" onClose={onClose} confirmDiscard={false}>
      <p className="dlg-text"><b>{title}</b></p>
      <ul className="dlg-list toners recv-all">
        {orders.map((o) => (
          <li key={o.id}><i className={`cdot ${o.color ? o.color.toLowerCase() : 'g'}`} /><b>{o.code}</b> ×{o.qty}<span className="recv-all__to">{o.location}</span></li>
        ))}
      </ul>
      <div className="field"><span>Dokumenti{docs.length > 0 ? ` (${docs.length})` : ''}</span>
        {docs.length === 0 && <p className="muted">Nav pievienotu dokumentu.</p>}
        {docs.length > 0 && (
          <ul className="flist">
            {docs.map((d) => (
              <li key={d.id}>
                <button type="button" className="flist__name" onClick={() => setViewing(d)}>{d.name}</button><small>{fmtSize(d.size)}</small>
                <button type="button" className="icon-btn" disabled={busy} aria-label={`Dzēst ${d.name}`} title="Dzēst" onClick={() => setDeleting(d)}>{Icon.trash(15)}</button>
              </li>
            ))}
          </ul>
        )}
        <FilePicker onPick={add} disabled={busy} label={busy ? 'Saglabā…' : 'Pievienot dokumentu'} />
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {viewing && <FileViewer file={{ url: deliveryDocUrl(viewing.id), name: viewing.name, mime: viewing.mime }} onClose={() => setViewing(null)} />}
      <Dialog.Footer>
        <Dialog.Cancel>Aizvērt</Dialog.Cancel>
      </Dialog.Footer>
    </Dialog.Frame>
    {deleting && (
      <DestructiveDialog title="Dzēst dokumentu" confirmLabel="Dzēst" onClose={() => setDeleting(null)}
        onConfirm={async () => { await api.deleteDeliveryDoc(deleting.id); setDocs((l) => l.filter((x) => x.id !== deleting.id)); onChange() }}>
        <p className="dlg-text">Dzēst <b>{deleting.name}</b>? To nevar atsaukt.{orders.length > 1 && ' Dokuments pazudīs no visiem šīs grupas pasūtījumiem.'}</p>
      </DestructiveDialog>
    )}
    </>
  )
}
