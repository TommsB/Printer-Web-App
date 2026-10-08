import { useEffect, useState } from 'react'
import { api } from '../api'
import { refreshAll } from '../cache'
import { clearUndo, useUndoOffer } from '../undo'

const SHOWN_MS = 8000

/**
 * The bar that offers "Atsaukt" after Izlietots / Saņemt (see undo.ts). It goes away by itself after a few
 * seconds; the server allows the undo a little longer, so a tap at the last moment still works.
 */
export function UndoToast() {
  const offer = useUndoOffer()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!offer) return
    const timer = setTimeout(clearUndo, SHOWN_MS)
    return () => clearTimeout(timer)
  }, [offer])

  if (!offer && !error) return null
  const undo = async () => {
    if (!offer || busy) return
    setBusy(true)
    try {
      await api.undoMovements(offer.ids)
      clearUndo()
      refreshAll() // every list that shows the reserve, orders or history
    } catch (err) {
      clearUndo()
      setError(err instanceof Error ? err.message : 'Neizdevās atsaukt')
      setTimeout(() => setError(''), 5000)
    } finally { setBusy(false) }
  }
  return (
    <div className="undo" role="status">
      {error
        ? <span className="undo__txt">{error}</span>
        : <>
            <span className="undo__txt">{offer!.text}</span>
            <button type="button" className="undo__btn" disabled={busy} onClick={undo}>{busy ? 'Atsauc…' : 'Atsaukt'}</button>
          </>}
    </div>
  )
}
