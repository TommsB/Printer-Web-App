import { useEffect, useState } from 'react'
import { api, type Session } from '../api'
import { canAutoFocus } from '../lib'

/** A failed Microsoft sign-in comes back as /?login_error=…; show it once and clean the address bar. */
function takeLoginError(): string {
  const params = new URLSearchParams(window.location.search)
  const message = params.get('login_error') ?? ''
  if (message) {
    params.delete('login_error')
    const rest = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''))
  }
  return message
}

export function LoginPage({ onLoggedIn }: { onLoggedIn: (s: Session) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(takeLoginError)
  const [busy, setBusy] = useState(false)
  // What the server offers. Until it answers (or if it can't be asked), show the password form.
  const [offer, setOffer] = useState({ microsoft: false, password: true })
  useEffect(() => { api.authConfig().then(setOffer).catch(() => {}) }, [])

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
        {/* The sign from the opening screen, in the chosen theme's colours (index.css, .login__sign). */}
        <svg className="login__sign" viewBox="20 24 160 152" aria-hidden="true">
          <g className="a"><path d="M70 78V40h48l14 14v24" /><path d="M118 40v14h14" /><path d="M70 122v40h60v-40" /></g>
          <g className="b">
            <path d="M70 142H50a12 12 0 0 1-12-12V90a12 12 0 0 1 12-12h100a12 12 0 0 1 12 12v40a12 12 0 0 1-12 12h-20" />
            <circle cx="138" cy="95" r="4" /><circle cx="151" cy="95" r="4" />
            <path d="M56 122h88" /><path d="M84 137h32" /><path d="M84 149h32" />
          </g>
        </svg>
        <h1>Printeri</h1>
        {/* A normal link: the browser has to leave the app for Microsoft's sign-in page and come back. */}
        {offer.microsoft && (
          <a className="btn ms-btn" href="/api/auth/microsoft/login">
            <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" fill="#F25022" /><rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
              <rect x="1" y="11" width="9" height="9" fill="#00A4EF" /><rect x="11" y="11" width="9" height="9" fill="#FFB900" />
            </svg>
            Pieslēgties ar Microsoft
          </a>
        )}
        {offer.microsoft && offer.password && <div className="login__or"><span>vai ar paroli</span></div>}
        {offer.password && <>
          <label className="login__field"><span className="sr">Lietotājvārds</span>
            <input name="username" placeholder="Lietotājvārds" autoComplete="username" autoCapitalize="none" spellCheck={false}
              autoFocus={canAutoFocus() && !offer.microsoft} value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="login__field"><span className="sr">Parole</span>
            <input name="password" type="password" placeholder="Parole" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        </>}
        {error && <div className="error" role="alert">{error}</div>}
        {offer.password && <button className={offer.microsoft ? 'btn' : 'btn primary'} disabled={busy}>{busy ? 'Ieiet…' : 'Ieiet'}</button>}
      </form>
    </main>
  )
}
