"""Sign in with Microsoft (Entra ID): OpenID Connect authorization-code flow with PKCE.

  browser → GET /api/auth/microsoft/login      → redirect to Microsoft's sign-in page
  Microsoft → GET /api/auth/microsoft/callback → we swap the one-time code for an ID token (server to server),
                                                 check it, find/create the app user, start the normal session.

Needs an app registration in Entra (single tenant, platform "Web") with the redirect URI
<public_url>/api/auth/microsoft/callback and a client secret; the values go in ENTRA_TENANT_ID,
ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and PUBLIC_URL. Without them this is switched off.

The ID token comes straight from Microsoft's token endpoint over verified TLS, so (per OpenID Connect Core
3.1.3.7) its signature need not be re-checked; issuer, audience, tenant, nonce and expiry are checked here.
"""

import base64
import hashlib
import json
import secrets
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse

from .auth import microsoft_enabled, start_session
from .config import config, flag
from .db import db_dep

router = APIRouter(prefix="/api/auth/microsoft", tags=["auth"])

AUTHORITY = "https://login.microsoftonline.com"
PENDING_TTL = 600  # seconds a started sign-in stays valid
_pending: dict[str, dict] = {}  # state -> {nonce, verifier, expires}; in memory (a sign-in only takes seconds)


def _redirect_uri() -> str:
    return config["public_url"].rstrip("/") + "/api/auth/microsoft/callback"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@router.get("/login")
def login() -> RedirectResponse:
    if not microsoft_enabled():
        raise HTTPException(404, "Microsoft sign-in is not configured")
    now = time.time()
    for s in [s for s, p in _pending.items() if p["expires"] < now]:
        _pending.pop(s, None)
    state, nonce, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(24), secrets.token_urlsafe(48)
    _pending[state] = {"nonce": nonce, "verifier": verifier, "expires": now + PENDING_TTL}
    query = urllib.parse.urlencode({
        "client_id": config["entra_client_id"],
        "response_type": "code",
        "redirect_uri": _redirect_uri(),
        "response_mode": "query",
        "scope": "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()),
        "code_challenge_method": "S256",
        "prompt": "select_account",
    })
    return RedirectResponse(f"{AUTHORITY}/{config['entra_tenant_id']}/oauth2/v2.0/authorize?{query}", 302)


def exchange_code(code: str, verifier: str) -> dict:
    """Swap the one-time code for tokens at Microsoft's token endpoint. Returns the JSON answer."""
    data = urllib.parse.urlencode({
        "client_id": config["entra_client_id"],
        "client_secret": config["entra_client_secret"],
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": _redirect_uri(),
        "code_verifier": verifier,
    }).encode()
    req = urllib.request.Request(f"{AUTHORITY}/{config['entra_tenant_id']}/oauth2/v2.0/token", data=data)
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:  # Microsoft explains errors in a JSON body
        try:
            return json.load(e)
        except ValueError:
            return {"error": f"http_{e.code}"}
    except (urllib.error.URLError, TimeoutError) as e:
        return {"error": "unreachable", "error_description": str(e)}


def token_claims(id_token: str) -> dict:
    payload = id_token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def check_claims(claims: dict, nonce: str) -> str | None:
    """None if the ID token is for this app, this tenant and this sign-in; otherwise what is wrong."""
    tenant = config["entra_tenant_id"]
    if claims.get("aud") != config["entra_client_id"]:
        return "aud"
    if claims.get("tid") != tenant or claims.get("iss") != f"{AUTHORITY}/{tenant}/v2.0":
        return "tenant"
    if claims.get("nonce") != nonce:
        return "nonce"
    if float(claims.get("exp", 0)) < time.time():
        return "expired"
    return None


def resolve_user(conn: sqlite3.Connection, upn: str) -> str | None:
    """The app username for a Microsoft account (its sign-in name, e.g. janis.berzins@tenax.lv).

    An existing user matches by the full name or by the part before the @ (so the logins created before
    Microsoft sign-in keep their role, printer order and templates). An unknown account becomes a new
    standard user when ENTRA_AUTO_CREATE is on; otherwise it is refused (returns None)."""
    upn = upn.strip().lower()
    local = upn.split("@")[0]
    row = conn.execute("SELECT username FROM users WHERE username = ? COLLATE NOCASE"
                       " OR username = ? COLLATE NOCASE ORDER BY username = ? COLLATE NOCASE DESC LIMIT 1",
                       (upn, local, upn)).fetchone()
    if row:
        return row["username"]
    if not flag("entra_auto_create") or not local:
        return None
    conn.execute("INSERT INTO users (username, password_hash, role, created_by) VALUES (?, '', 'standard', 'microsoft')",
                 (local,))
    return local


def _back(error: str = "") -> RedirectResponse:
    return RedirectResponse("/" + (f"?login_error={urllib.parse.quote(error)}" if error else ""), 302)


@router.get("/callback")
def callback(code: str | None = None, state: str | None = None, error: str | None = None,
             error_description: str | None = None, conn: sqlite3.Connection = Depends(db_dep)) -> RedirectResponse:
    """Microsoft sends the browser back here. Any problem returns to the login page with a message."""
    pending = _pending.pop(state or "", None)
    if error:  # e.g. the user cancelled, or their account isn't assigned to the app in Entra
        return _back("Microsoft pieslēgšanās neizdevās" + (f": {error_description.splitlines()[0][:200]}" if error_description else ""))
    if not microsoft_enabled() or not code or not pending or pending["expires"] < time.time():
        return _back("Pieslēgšanās sesija ir beigusies. Mēģiniet vēlreiz.")
    tokens = exchange_code(code, pending["verifier"])
    if "id_token" not in tokens:
        return _back(f"Microsoft neapstiprināja pieslēgšanos ({tokens.get('error', 'kļūda')})")
    claims = token_claims(tokens["id_token"])
    if check_claims(claims, pending["nonce"]):
        return _back("Microsoft atbilde neatbilst šai lietotnei")
    upn = claims.get("preferred_username") or claims.get("email") or claims.get("upn") or ""
    username = resolve_user(conn, upn) if upn else None
    if not username:
        return _back(f"Kontam {upn or '?'} nav piekļuves šai lietotnei. Lūdziet administratoram jūs pievienot.")
    response = _back()
    start_session(response, username, conn)
    return response
