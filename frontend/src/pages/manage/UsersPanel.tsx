import { useEffect, useState } from 'react'
import { api, type AppUser, type Role } from '../../api'
import { useApiData } from '../../cache'
import { Dialog, DestructiveDialog } from '../../components/Dialog'
import { matches } from '../../components/SearchBox'
import { Segmented } from '../../components/Toggle'
import { useApp } from '../../ctx'
import { Icon } from '../../icons'
import { canAutoFocus, ROLE_LV } from '../../lib'

const ROLES = [{ value: 'standard' as Role, label: ROLE_LV.standard }, { value: 'admin' as Role, label: ROLE_LV.admin }]
const MIN_PASSWORD = 6

/**
 * Pārvaldība → Lietotāji (admins only; the server refuses these requests for anyone else).
 * The two roles can do the same in the app — an administrator can additionally manage users here.
 */
export function UsersPanel({ query, adding, onCloseAdd }: { query: string; adding: boolean; onCloseAdd: () => void }) {
  const { user: me } = useApp()
  const users = useApiData<AppUser[]>('users', api.users, [])
  const [editing, setEditing] = useState<AppUser | null>(null)
  // With Microsoft sign-in configured, a user can exist without a password.
  const [microsoft, setMicrosoft] = useState(false)
  useEffect(() => { api.authConfig().then((c) => setMicrosoft(c.microsoft)).catch(() => {}) }, [])
  const shown = users.data.filter((u) => matches(query, u.username, ROLE_LV[u.role]))

  return (
    <>
      <ul className="mlist">
        {shown.map((u) => (
          <li key={u.username}>
            <button className="mrow" onClick={() => setEditing(u)}>
              <span className="mrow__ic">{Icon.user(18)}</span>
              <span className="mrow__body">
                <span className="mrow__l1"><b>{u.username}</b>{u.username === me && <span className="tag-s">Jūs</span>}</span>
                <span className="mrow__l2">{ROLE_LV[u.role]}{u.has_password === false && ' · ienāk ar Microsoft'}</span>
              </span>
              <span className="mrow__chev">{Icon.chevron(18)}</span>
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="muted empty">{users.loading ? 'Ielādē…' : query ? 'Nekas netika atrasts.' : 'Vēl nav neviena.'}</p>}

      {(adding || editing) && (
        <UserEditor user={editing} isSelf={editing?.username === me} microsoft={microsoft}
          onClose={() => { setEditing(null); onCloseAdd() }} onSaved={users.reload} />
      )}
    </>
  )
}

/** Add a user, or change one's role / reset the password / delete. */
function UserEditor({ user, isSelf, microsoft, onClose, onSaved }: {
  user: AppUser | null // null = add a new user
  isSelf: boolean
  microsoft: boolean // Microsoft sign-in is configured: a new user may be created without a password
  onClose: () => void
  onSaved: () => Promise<unknown>
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [role, setRole] = useState<Role>(user?.role ?? 'standard')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Empty is fine when editing (= keep the current one) and, with Microsoft sign-in, for a new user (= no password).
  const passwordOk = password.length >= MIN_PASSWORD || (password === '' && (user !== null || microsoft))
  const valid = passwordOk && (user !== null || username.trim() !== '')

  const save = async () => {
    if (user) await api.updateUser(user.username, { role, ...(password && { password }) })
    else await api.createUser(username.trim(), password, role)
    await onSaved()
  }

  return (
    <>
      <Dialog.Frame title={user ? user.username : 'Jauns lietotājs'} onClose={onClose} onSubmit={save}>
        {!user && (
          <label>Lietotājvārds
            <input name="new-username" autoFocus={canAutoFocus()} autoComplete="off" autoCapitalize="none" spellCheck={false}
              value={username} onChange={(e) => setUsername(e.target.value)} placeholder="piem. janis.berzins…" />
          </label>
        )}
        {/* Hidden by default; the eye shows it, so the administrator can check what they typed before passing it on.
            "new-password": the browser must not fill in the administrator's own saved password here. */}
        {!user && microsoft && (
          <p className="fnote">Ja lietotājs ienāks ar Microsoft kontu, lietotājvārdam jāsakrīt ar konta nosaukumu pirms @ (piem. janis.berzins), un paroli var atstāt tukšu.</p>
        )}
        <label>{user ? 'Jauna parole (atstājiet tukšu, lai nemainītu)' : microsoft ? 'Parole (nav obligāta)' : 'Parole'}
          <span className="pw">
            <input name="new-password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false}
              value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`vismaz ${MIN_PASSWORD} zīmes…`} />
            <button type="button" className="pw__eye" onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Paslēpt paroli' : 'Rādīt paroli'} title={showPassword ? 'Paslēpt paroli' : 'Rādīt paroli'}>
              {showPassword ? Icon.eyeOff(18) : Icon.eye(18)}
            </button>
          </span>
        </label>
        {password !== '' && !passwordOk && <span className="error">Parolei jābūt vismaz {MIN_PASSWORD} zīmes garai</span>}
        <div className="field"><span>Loma</span>
          {isSelf
            ? <p className="fnote">{ROLE_LV[role]}. Savu lomu mainīt nevar.</p>
            : <Segmented label="Loma" value={role} onChange={setRole} options={ROLES} />}
        </div>
        <p className="fnote">Abas lomas lietotnē var darīt vienu un to pašu. Administrators papildus var pārvaldīt lietotājus.</p>
        {user && password !== '' && passwordOk && !isSelf && <p className="fnote">Mainot paroli, lietotājs tiks izrakstīts no visām ierīcēm.</p>}

        <Dialog.Footer>
          {user && !isSelf && <Dialog.Start><button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>Dzēst</button></Dialog.Start>}
          <Dialog.Cancel />
          <Dialog.Confirm disabled={!valid}>Saglabāt</Dialog.Confirm>
        </Dialog.Footer>
      </Dialog.Frame>

      {user && confirmDelete && (
        <DestructiveDialog title="Dzēst lietotāju" confirmLabel="Dzēst" onClose={() => setConfirmDelete(false)}
          onConfirm={async () => { await api.deleteUser(user.username); await onSaved(); onClose() }}>
          <p className="dlg-text">Dzēst lietotāju „{user.username}”? Viņš vairs nevarēs ieiet, un viņa personīgie iestatījumi (printeru secība, e-pasta veidnes) tiks dzēsti.<br />
            <span className="muted">Vēstures ierakstos viņa vārds paliek.</span></p>
        </DestructiveDialog>
      )}
    </>
  )
}
