"""Cookie-session login, and user management.

Users live in the database (table `users`: bcrypt hash + role). Two roles: 'admin' and 'standard'. They can do
exactly the same in the app, except that only an admin can manage users (Pārvaldība → Lietotāji).

Two ways to log in: a password kept here (bcrypt), and "Sign in with Microsoft" (microsoft.py, when configured).
A user with an empty password hash can only use Microsoft.

auth_users.json (project root, {"users": {name: bcrypt_hash}}) is only the bootstrap: when the users table is
empty — first start, or first start after this was added — its users are imported as admins. To recover a lost
admin login use scripts/set_user.py.

Sessions are kept in the database (table `sessions`), so updating or restarting the app doesn't log anyone
out. A login lasts SESSION_TTL from the last time the app was used: it is extended while someone keeps using it
and ends only after that long without a visit (or on Iziet, a password reset, or the user being deleted).
"""

import hashlib
import json
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from .config import PROJECT_ROOT, config, flag
from .db import db_dep, get_db

USERS_PATH = PROJECT_ROOT / "auth_users.json"
SESSION_COOKIE = "session"
SESSION_TTL = timedelta(days=30)
RENEW_AFTER = timedelta(days=1)  # a session in use is pushed out to the full SESSION_TTL again at most this often
ROLES = ("admin", "standard")
USERNAME_RE = re.compile(r"^[\w.\-@]{1,40}$")  # letters (any alphabet), digits, _ . - @ — no spaces

router = APIRouter(prefix="/api/auth", tags=["auth"])
users_router = APIRouter(prefix="/api/users", tags=["users"])
# In-memory copy of the sessions table (token hash -> {username, expires_at}), so a request doesn't need a
# database read to know who is asking. Filled on login and, after a restart, on each session's first request.
_sessions: dict[str, dict] = {}


def _key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _set_cookie(response: Response, token: str) -> None:
    """The cookie is marked Secure when the app is served over https (PUBLIC_URL)."""
    response.set_cookie(
        SESSION_COOKIE, token, httponly=True, samesite="lax", max_age=int(SESSION_TTL.total_seconds()),
        secure=config["public_url"].lower().startswith("https://"),
    )


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def bootstrap_users() -> None:
    """Empty users table → import the logins from auth_users.json as admins (so nobody is locked out)."""
    with get_db() as conn:
        if conn.execute("SELECT 1 FROM users LIMIT 1").fetchone() or not USERS_PATH.exists():
            return
        with open(USERS_PATH, encoding="utf-8-sig") as f:
            users = json.load(f).get("users", {})
        conn.executemany("INSERT INTO users (username, password_hash, role, created_by) VALUES (?,?,'admin','auth_users.json')",
                         list(users.items()))


def microsoft_enabled() -> bool:
    """Sign in with Microsoft is on once the Entra app registration values and the public address are set."""
    return all(config[k] for k in ("entra_tenant_id", "entra_client_id", "entra_client_secret", "public_url"))


def start_session(response: Response, username: str, conn: sqlite3.Connection) -> None:
    """Log `username` in on this browser: remember the session and set its cookie on `response`.
    Written with the request's own connection (`conn`), so it is saved together with whatever else the
    login did. Also the moment old, expired sessions are cleared out."""
    token = secrets.token_urlsafe(32)
    expires = _now() + SESSION_TTL
    conn.execute("DELETE FROM sessions WHERE expires_ts < ?", (_now().isoformat(),))
    conn.execute("INSERT INTO sessions (token_hash, username, expires_ts) VALUES (?,?,?)",
                 (_key(token), username, expires.isoformat()))
    _sessions[_key(token)] = {"username": username, "expires_at": expires}
    _set_cookie(response, token)


@router.get("/config")
def auth_config() -> dict:
    """What the login page should offer (public: it is needed before anyone is logged in)."""
    return {"microsoft": microsoft_enabled(), "password": flag("password_login") or not microsoft_enabled()}


class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginBody, response: Response, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    if microsoft_enabled() and not flag("password_login"):
        raise HTTPException(403, "Pieslēgšanās ar paroli ir izslēgta. Izmantojiet Microsoft kontu.")
    row = conn.execute("SELECT password_hash, role FROM users WHERE username = ?", (body.username,)).fetchone()
    # An empty hash = a Microsoft-only user: no password can match it.
    if not row or not row["password_hash"] or not bcrypt.checkpw(body.password.encode(), row["password_hash"].encode()):
        raise HTTPException(401, "Nepareizs lietotājvārds vai parole")
    start_session(response, body.username, conn)
    return {"username": body.username, "role": row["role"]}


@router.post("/logout")
def logout(response: Response, session: str | None = Cookie(default=None)) -> dict:
    if session:
        _sessions.pop(_key(session), None)
        with get_db() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_key(session),))
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


def current_username(response: Response, session: str | None = Cookie(default=None)) -> str:
    key = _key(session) if session else ""
    entry = _sessions.get(key)
    if entry is None and key:  # not in memory: the app was restarted since this login
        with get_db() as conn:
            row = conn.execute("SELECT username, expires_ts FROM sessions WHERE token_hash = ?", (key,)).fetchone()
        if row:
            entry = _sessions[key] = {"username": row["username"], "expires_at": datetime.fromisoformat(row["expires_ts"])}
    now = _now()
    if not entry or entry["expires_at"] < now:
        _sessions.pop(key, None)
        raise HTTPException(401, "Not logged in")
    if entry["expires_at"] - now < SESSION_TTL - RENEW_AFTER:
        # Still in use: start the full period again (and the cookie's with it).
        entry["expires_at"] = now + SESSION_TTL
        try:
            with get_db() as conn:
                conn.execute("UPDATE sessions SET expires_ts = ? WHERE token_hash = ?", (entry["expires_at"].isoformat(), key))
            _set_cookie(response, session)
        except sqlite3.Error as e:  # extending is a convenience: never fail the request over it
            print(f"[auth] could not extend a session: {e}")
    return entry["username"]


def _role(conn: sqlite3.Connection, username: str) -> str:
    row = conn.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
    if not row:  # the user was deleted while still logged in
        raise HTTPException(401, "Not logged in")
    return row["role"]


def require_admin(username: str = Depends(current_username), conn: sqlite3.Connection = Depends(db_dep)) -> str:
    """Dependency for the user-management endpoints. The role is read fresh from the database on every
    request, so a role change or a deleted user takes effect immediately."""
    if _role(conn, username) != "admin":
        raise HTTPException(403, "Tikai administrators var pārvaldīt lietotājus")
    return username


@router.get("/me")
def me(username: str = Depends(current_username), conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    return {"username": username, "role": _role(conn, username)}


# ---- user management (admin only) -----------------------------------------------------------

MIN_PASSWORD = 6


class UserIn(BaseModel):
    username: str
    password: str = Field(default="", max_length=200)  # "" = no password: the user signs in with Microsoft
    role: str = "standard"


class UserUpdate(BaseModel):
    password: str | None = Field(default=None, min_length=MIN_PASSWORD, max_length=200)  # None = keep the current one
    role: str | None = None


def _admins(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]


def _drop_sessions(conn: sqlite3.Connection, username: str) -> None:
    conn.execute("DELETE FROM sessions WHERE username = ?", (username,))
    for key in [k for k, s in _sessions.items() if s["username"] == username]:
        _sessions.pop(key, None)


@users_router.get("")
def list_users(conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    return [{**dict(r), "has_password": bool(r["has_password"])} for r in conn.execute(
        "SELECT username, role, created_ts, created_by, password_hash != '' AS has_password"
        " FROM users ORDER BY role != 'admin', username COLLATE NOCASE")]


@users_router.post("", status_code=201)
def create_user(body: UserIn, conn: sqlite3.Connection = Depends(db_dep), admin: str = Depends(require_admin)) -> dict:
    name = body.username.strip()
    if not USERNAME_RE.match(name):
        raise HTTPException(400, "Lietotājvārdā drīkst būt burti, cipari un . _ - @ (bez atstarpēm, līdz 40 zīmēm)")
    if body.role not in ROLES:
        raise HTTPException(400, "Nezināma loma")
    # No password is only allowed when the user can sign in with Microsoft instead.
    if body.password == "" and not microsoft_enabled():
        raise HTTPException(400, "Norādiet paroli")
    if body.password and len(body.password) < MIN_PASSWORD:
        raise HTTPException(400, f"Parolei jābūt vismaz {MIN_PASSWORD} zīmes garai")
    if conn.execute("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE", (name,)).fetchone():
        raise HTTPException(409, "Šāds lietotājs jau ir")
    conn.execute("INSERT INTO users (username, password_hash, role, created_by) VALUES (?,?,?,?)",
                 (name, hash_password(body.password) if body.password else "", body.role, admin))
    return {"username": name, "role": body.role}


@users_router.put("/{username}")
def update_user(username: str, body: UserUpdate, conn: sqlite3.Connection = Depends(db_dep),
                admin: str = Depends(require_admin)) -> dict:
    row = conn.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        raise HTTPException(404, "Lietotājs nav atrasts")
    if body.role is not None and body.role != row["role"]:
        if body.role not in ROLES:
            raise HTTPException(400, "Nezināma loma")
        if row["role"] == "admin" and _admins(conn) <= 1:
            raise HTTPException(409, "Jāpaliek vismaz vienam administratoram")
        conn.execute("UPDATE users SET role = ? WHERE username = ?", (body.role, username))
    if body.password:
        conn.execute("UPDATE users SET password_hash = ? WHERE username = ?", (hash_password(body.password), username))
        if username != admin:
            _drop_sessions(conn, username)  # a reset password logs that user out everywhere
    return dict(conn.execute("SELECT username, role FROM users WHERE username = ?", (username,)).fetchone())


@users_router.delete("/{username}")
def delete_user(username: str, conn: sqlite3.Connection = Depends(db_dep), admin: str = Depends(require_admin)) -> dict:
    row = conn.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        raise HTTPException(404, "Lietotājs nav atrasts")
    if username == admin:
        raise HTTPException(409, "Sevi dzēst nevar")
    if row["role"] == "admin" and _admins(conn) <= 1:
        raise HTTPException(409, "Jāpaliek vismaz vienam administratoram")
    conn.execute("DELETE FROM users WHERE username = ?", (username,))
    # Their personal settings go too; what they did (history entries, orders) keeps their name.
    conn.execute("DELETE FROM user_printer_order WHERE username = ?", (username,))
    conn.execute("DELETE FROM user_settings WHERE username = ?", (username,))
    conn.execute("DELETE FROM push_subscriptions WHERE username = ?", (username,))  # no more notifications
    _drop_sessions(conn, username)
    return {"deleted": username}
