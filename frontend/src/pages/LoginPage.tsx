import { useState } from 'react'
import { api, type Session } from '../api'
import { canAutoFocus } from '../lib'

export function LoginPage({ onLoggedIn }: { onLoggedIn: (s: Session) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      onLoggedIn(await api.login(username, password))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kļūda')
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <form className="card login__form" onSubmit={submit}>
        <h1>Printeri</h1>
        <label className="login__field"><span className="sr">Lietotājvārds</span>
          <input name="username" placeholder="Lietotājvārds" autoComplete="username" autoCapitalize="none" spellCheck={false}
            autoFocus={canAutoFocus()} value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="login__field"><span className="sr">Parole</span>
          <input name="password" type="password" placeholder="Parole" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Ieiet…' : 'Ieiet'}</button>
      </form>
    </main>
  )
}
