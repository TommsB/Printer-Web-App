import { createContext, use } from 'react'
import type { Role, TonerEvent } from './api'

export interface AppCtx {
  user: string
  /** 'admin' can also manage users (Pārvaldība → Lietotāji); otherwise both roles are equal. */
  role: Role
  logout: () => void
  company: string // '' = all
  setCompany: (c: string) => void
  companies: string[]
  /** Detected toner replacements waiting for review (drives the Žurnāls badge). */
  events: TonerEvent[]
  reloadEvents: () => Promise<unknown>
  /** Remove a reviewed replacement locally (so it can animate out before the server reload). */
  dropEvent: (id: number) => void
}

export const AppContext = createContext<AppCtx | null>(null)

export function useApp(): AppCtx {
  const v = use(AppContext)
  if (!v) throw new Error('AppContext missing')
  return v
}
