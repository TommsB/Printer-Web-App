import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, type Printer, type StoreLocation, type Toner } from '../api'
import { useApiData } from '../cache'
import { matches, SearchBox } from '../components/SearchBox'
import { TopBar } from '../components/TopBar'
import { useApp } from '../ctx'
import { Icon } from '../icons'
import { LocationEditor } from './manage/LocationEditor'
import { UsersPanel } from './manage/UsersPanel'
import { PrinterEditor } from './manage/PrinterEditor'
import { TonerEditor } from './manage/TonerEditor'
import { CDot } from '../components/ColorDot'

type Tab = 'printers' | 'toners' | 'locations' | 'users'
const TABS: { key: Tab; label: string }[] = [
  // "Komponenti": toners, drums and other consumables (the tab keeps its old key 'toners' in the address).
  { key: 'printers', label: 'Printeri' }, { key: 'toners', label: 'Komponenti' }, { key: 'locations', label: 'Glabāšanas vietas' },
]
const USERS_TAB = { key: 'users' as Tab, label: 'Lietotāji' } // administrators only
const ADD_LABEL: Record<Tab, string> = { printers: 'Printeris', toners: 'Komponents', locations: 'Vieta', users: 'Lietotājs' }
const KIND_LV: Record<string, string> = { toner: 'Toneris', drum: 'Drums', other: 'Cits' }

/** Which editor is open (null item = adding a new one). Each editor owns its own form state. */
type OpenEditor =
  | { kind: 'printer'; item: Printer | null; template?: Printer } // template: new printer copied with "Dublēt"
  | { kind: 'toner'; item: Toner | null }
  | { kind: 'location'; item: StoreLocation | null }
  | null

export function ManagePage() {
  // Cached (shared with the other pages): shows the last copy instantly, refreshes in the background.
  const pr = useApiData<Printer[]>('printers', api.printers, [])
  const tn = useApiData<Toner[]>('toners', api.toners, [])
  const lc = useApiData<StoreLocation[]>('locations', api.locations, [])
  // The section lives in the URL (/manage?tab=toners), so it survives reloads and can be linked.
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  // Lietotāji only exists for administrators (the server refuses the data to anyone else anyway).
  const isAdmin = useApp().role === 'admin'
  const tabs = isAdmin ? [...TABS, USERS_TAB] : TABS
  const tab: Tab = tabParam === 'toners' || tabParam === 'locations' || (tabParam === 'users' && isAdmin) ? tabParam : 'printers'
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<OpenEditor>(null)
  const [addingUser, setAddingUser] = useState(false)

  const setTab = (t: Tab) => {
    setParams(t === 'printers' ? {} : { tab: t }, { replace: true })
    setQuery('')
  }
  const reloadAll = () => Promise.all([pr.reload(), tn.reload(), lc.reload()])
  const close = () => setEditor(null)

  // toner id -> printers using it (Toneri tab, and delete protection in the toner editor)
  const usage = new Map<number, Printer[]>()
  for (const p of pr.data) for (const t of p.toners) usage.set(t.id, [...(usage.get(t.id) ?? []), p])
  const reserveOf = (tonerId: number) => pr.data.reduce((n, p) => n + (p.toners.find((t) => t.id === tonerId)?.qty ?? 0), 0)

  const q = query.trim()
  const printers = pr.data.filter((p) => matches(q, p.location, p.model, p.ip, p.brand, p.company))
  const toners = tn.data.filter((t) => matches(q, t.code, KIND_LV[t.kind], ...(usage.get(t.id) ?? []).map((p) => p.location)))
  const locations = lc.data.filter((l) => matches(q, l.name, l.short))
  const empty = (tab === 'printers' && !printers.length) || (tab === 'toners' && !toners.length) || (tab === 'locations' && !locations.length)

  const add = () => {
    if (tab === 'users') return setAddingUser(true)
    setEditor(tab === 'printers' ? { kind: 'printer', item: null }
      : tab === 'toners' ? { kind: 'toner', item: null } : { kind: 'location', item: null })
  }

  // Shown in the panel and again in the compact top bar once you scroll down.
  const sections = (
    <div className="seg" role="group" aria-label="Sadaļa">
      {tabs.map((t) => (
        <button key={t.key} aria-pressed={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
      ))}
    </div>
  )

  return (
    <>
      <TopBar title={['Pārvaldība', 'un iestatījumi']} sticky={sections} />

      <section className="pane mpane">
        <div className="mhead">
          {sections}
          <div className="mhead__actions">
            <SearchBox key={tab} value={query} onChange={setQuery} placeholder="Meklēt…" />
            <button className="btn small primary add-btn" onClick={add}>
              {Icon.plus(16)}<span>{ADD_LABEL[tab]}</span>
            </button>
          </div>
        </div>
        <p className="mhint">
          {tab === 'printers' && `${pr.data.length} printeri. Pieskarieties printerim, lai labotu tā datus, komponentus un normas.`}
          {tab === 'toners' && `${tn.data.length} komponentu kodi: toneri, drumi (ar „D” krāsas aplītī) un citi. Komponentu piesaista printerim printera iestatījumos.`}
          {tab === 'locations' && 'Vietas, kur glabājas rezerves kasetnes (nav saistītas ar printera atrašanās vietu). Saīsinājumu rāda tonera rindā Krājumos.'}
          {tab === 'users' && 'Kas var ieiet lietotnē. Abas lomas var darīt vienu un to pašu; tikai administrators var pārvaldīt lietotājus.'}
        </p>

        {tab === 'users' && <UsersPanel query={q} adding={addingUser} onCloseAdd={() => setAddingUser(false)} />}

        <ul className="mlist">
          {tab === 'printers' && printers.map((p) => (
            <li key={p.id}>
              <button className={p.active ? 'mrow' : 'mrow off'} onClick={() => setEditor({ kind: 'printer', item: p })}>
                <span className="mrow__ic">{Icon.printer(18)}</span>
                <span className="mrow__body">
                  <span className="mrow__l1"><b>{p.location}</b>
                    {!p.active && <span className="tag-s">Neaktīvs</span>}
                    {p.active && !p.snmp_enabled && <span className="tag-s">SNMP izsl.</span>}
                  </span>
                  <span className="mrow__l2">{[p.model, p.ip, p.company].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="mrow__meta">
                  <span className="dots">{p.toners.map((t) => <CDot key={t.id} color={t.color} kind={t.kind} />)}</span>
                </span>
                <span className="mrow__chev">{Icon.chevron(18)}</span>
              </button>
            </li>
          ))}

          {tab === 'toners' && toners.map((t) => {
            const users = usage.get(t.id) ?? []
            return (
              <li key={t.id}>
                <button className="mrow" onClick={() => setEditor({ kind: 'toner', item: t })}>
                  <span className="mrow__ic"><CDot big color={t.color} kind={t.kind} /></span>
                  <span className="mrow__body">
                    <span className="mrow__l1"><b>{t.code}</b>{t.kind !== 'toner' && t.kind !== 'drum' && <span className="tag-s">{KIND_LV[t.kind] ?? t.kind}</span>}</span>
                    <span className="mrow__l2">{users.length ? users.map((p) => p.location).join(', ') : 'Netiek izmantots'}</span>
                  </span>
                  <span className="mrow__meta"><b>{reserveOf(t.id)}</b><small>rezervē</small></span>
                  <span className="mrow__chev">{Icon.chevron(18)}</span>
                </button>
              </li>
            )
          })}

          {tab === 'locations' && locations.map((l) => (
            <li key={l.id}>
              <button className={l.active ? 'mrow' : 'mrow off'} onClick={() => setEditor({ kind: 'location', item: l })}>
                <span className="mrow__ic">{Icon.box(18)}</span>
                <span className="mrow__body">
                  <span className="mrow__l1"><b>{l.name}</b>{!l.active && <span className="tag-s">Arhivēta</span>}</span>
                  <span className="mrow__l2">{l.short ? <>Rāda kā „{l.short}”</> : 'Bez saīsinājuma'}</span>
                </span>
                <span className="mrow__meta"><b>{l.in_stock}</b><small>gab.</small></span>
                <span className="mrow__chev">{Icon.chevron(18)}</span>
              </button>
            </li>
          ))}
        </ul>
        {empty && <p className="muted empty">{q ? 'Nekas netika atrasts.' : 'Vēl nav neviena.'}</p>}
      </section>

      {editor?.kind === 'printer' && (
        // key: "Dublēt" swaps the open editor for a new-printer one, which must start with a fresh form.
        <PrinterEditor key={editor.item ? editor.item.id : `new-${editor.template?.id ?? ''}`} printer={editor.item} template={editor.template}
          onDuplicate={(p) => setEditor({ kind: 'printer', item: null, template: p })}
          toners={tn.data} onCatalogueChange={() => { tn.reload().catch(() => {}) }} locations={lc.data} onClose={close} onSaved={reloadAll} />
      )}
      {editor?.kind === 'toner' && (
        <TonerEditor toner={editor.item} users={editor.item ? usage.get(editor.item.id) ?? [] : []} onClose={close} onSaved={reloadAll} />
      )}
      {editor?.kind === 'location' && (
        <LocationEditor location={editor.item} onClose={close} onSaved={reloadAll} />
      )}
    </>
  )
}
