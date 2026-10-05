import { createContext, use, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Dialogs are composed from small parts instead of one component with mode flags:
 *
 *   <Dialog.Frame title=… onClose=… onSubmit=…>      ← portal, overlay, focus, Esc, busy/error
 *     …fields…
 *     <Dialog.Footer>
 *       <Dialog.Start><button…>Dzēst</button></Dialog.Start>   (optional, left side)
 *       <Dialog.Cancel />
 *       <Dialog.Confirm>Saglabāt</Dialog.Confirm>             (or <Dialog.Destructive>)
 *     </Dialog.Footer>
 *   </Dialog.Frame>
 *
 * The common shapes are ready-made below: ConfirmDialog, DestructiveDialog, InfoDialog.
 */

interface FrameState { onClose: () => void; busy: boolean; error: string }
const FrameContext = createContext<FrameState | null>(null)

function useFrame(): FrameState {
  const v = use(FrameContext)
  if (!v) throw new Error('Dialog parts must be inside <Dialog.Frame>')
  return v
}

/** Current state of every field and choice in the form, to tell whether anything was changed. */
function snapshot(f: HTMLFormElement): string {
  return [...f.querySelectorAll<HTMLElement>('input, select, textarea, [aria-checked], [aria-pressed]')].map((el) =>
    el instanceof HTMLInputElement ? (el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value)
      : el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.value
      : el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed'),
  ).join('\u0000')
}

/** The sheet itself. Submitting runs onSubmit (shows busy/errors) and closes on success. */
function Frame({ title, onClose, onSubmit, className, confirmDiscard = true, children }: {
  title: string
  onClose: () => void
  onSubmit?: () => Promise<unknown> | void
  className?: string // e.g. 'wide' for long editor forms
  confirmDiscard?: boolean // false for windows whose controls apply at once (nothing unsaved to lose)
  children: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [askDiscard, setAskDiscard] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const initial = useRef('')
  // Whatever had focus when the dialog opened (read on first render: an autoFocus field takes it before effects run).
  const [opener] = useState(() => document.activeElement as HTMLElement | null)

  // Take focus once, when opened (not on every re-render — that would steal it from a dialog opened on top),
  // remember the untouched form, and give focus back to the opener when the dialog closes.
  useEffect(() => {
    if (form.current) {
      initial.current = snapshot(form.current)
      if (!form.current.contains(document.activeElement)) form.current.focus()
    }
    return () => { if (opener?.isConnected) opener.focus() }
  }, [opener])

  // Backdrop click and Esc are easy to do by accident: ask before throwing away edits. (Atcelt closes directly.)
  const requestClose = () => {
    if (busy) return
    if (confirmDiscard && form.current && snapshot(form.current) !== initial.current) setAskDiscard(true)
    else onClose()
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!onSubmit || busy) return
    setBusy(true)
    setError('')
    try {
      await onSubmit()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kļūda')
      setBusy(false)
    }
  }

  return createPortal(
    <FrameContext value={{ onClose, busy, error }}>
      <div className="modal" onClick={requestClose} role="presentation">
        <form ref={form} className={`modal__box pane dialog${className ? ` ${className}` : ''}`} onClick={(e) => e.stopPropagation()}
          onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); requestClose() } }}
          role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
          <h3>{title}</h3>
          {children}
        </form>
      </div>
      {/* Sibling of the backdrop, not inside it: its clicks and keys must not reach this dialog. */}
      {askDiscard && (
        <DestructiveDialog title="Atmest izmaiņas?" confirmLabel="Atmest" onClose={() => setAskDiscard(false)} onConfirm={onClose}>
          <p className="dlg-text">Veiktās izmaiņas netiks saglabātas.</p>
        </DestructiveDialog>
      )}
    </FrameContext>,
    document.body,
  )
}

/** Error line + the action row (stays visible at the bottom of long dialogs). */
function Footer({ children }: { children: ReactNode }) {
  const { error } = useFrame()
  return (
    <>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="modal__actions">{children}</div>
    </>
  )
}

/** Left side of the footer, e.g. a "Dzēst" button in an editor. */
function Start({ children }: { children: ReactNode }) {
  return <span className="modal__left">{children}</span>
}

function Cancel({ children = 'Atcelt' }: { children?: ReactNode }) {
  const { onClose } = useFrame()
  return <button className="btn" type="button" onClick={onClose}>{children}</button>
}

function Confirm({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  const { busy } = useFrame()
  return <button className="btn primary" type="submit" disabled={busy || disabled}>{children}</button>
}

/** Like Confirm, but red: for actions that remove or cancel something. */
function Destructive({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  const { busy } = useFrame()
  return <button className="btn primary danger-solid" type="submit" disabled={busy || disabled}>{children}</button>
}

export const Dialog = { Frame, Footer, Start, Cancel, Confirm, Destructive }

// ---- ready-made shapes ------------------------------------------------------------------

interface ActionDialogProps {
  title: string
  confirmLabel: string
  onConfirm: () => Promise<unknown> | void
  onClose: () => void
  disabled?: boolean // confirm button disabled until the form is valid
  children: ReactNode
}

/** Question with Atcelt + a normal confirm button. */
export function ConfirmDialog({ title, confirmLabel, onConfirm, onClose, disabled, children }: ActionDialogProps) {
  return (
    <Dialog.Frame title={title} onClose={onClose} onSubmit={onConfirm}>
      {children}
      <Dialog.Footer>
        <Dialog.Cancel />
        <Dialog.Confirm disabled={disabled}>{confirmLabel}</Dialog.Confirm>
      </Dialog.Footer>
    </Dialog.Frame>
  )
}

/** Question with Atcelt + a red confirm button (removes, uses up or cancels something). */
export function DestructiveDialog({ title, confirmLabel, onConfirm, onClose, disabled, children }: ActionDialogProps) {
  return (
    <Dialog.Frame title={title} onClose={onClose} onSubmit={onConfirm}>
      {children}
      <Dialog.Footer>
        <Dialog.Cancel />
        <Dialog.Destructive disabled={disabled}>{confirmLabel}</Dialog.Destructive>
      </Dialog.Footer>
    </Dialog.Frame>
  )
}

/** Read-only information with just an "Aizvērt" button. */
export function InfoDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog.Frame title={title} onClose={onClose}>
      {children}
      <Dialog.Footer>
        <Dialog.Cancel>Aizvērt</Dialog.Cancel>
      </Dialog.Footer>
    </Dialog.Frame>
  )
}
