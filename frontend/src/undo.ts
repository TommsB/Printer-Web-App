import { useSyncExternalStore } from 'react'

/**
 * "Atsaukt": after Izlietots / Saņemt a small bar offers to take the action back for a few seconds — for
 * mis-taps, mostly on the phone. Any part of the app can offer one; the bar itself is in App (UndoToast).
 * Only one is shown at a time: a new action replaces the offer for the previous one.
 */
export interface UndoOffer { text: string; ids: number[]; key: number }

let current: UndoOffer | null = null
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

/** Offer to undo the history entries `ids` (what the action just wrote), described by `text`. */
export function offerUndo(text: string, ids: number[]): void {
  if (ids.length === 0) return
  current = { text, ids, key: Date.now() }
  emit()
}
export function clearUndo(): void {
  if (!current) return
  current = null
  emit()
}
export function useUndoOffer(): UndoOffer | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => current)
}
