"""Cookie-session login, and user management.

Users live in the database (table `users`: bcrypt hash + role). Two roles: 'admin' and 'standard'. They can do
exactly the same in the app, except that only an admin can manage users (Pārvaldība → Lietotāji).

auth_users.json (project root, {"users": {name: bcrypt_hash}}) is only the bootstrap: when the users table is
empty — first start, or first start after this was added — its users are imported as admins. To recover a lost
admin login use scripts/set_user.py. Sessions are in-memory, so a backend restart logs everyone out.
"""

import json
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from .config import PROJECT_ROOT
from .db import db_dep, get_db

USERS_PATH = PROJECT_ROOT / "auth_users.json"
SESSION_COOKIE = "session"
SESSION_TTL = timedelta(days=7)
ROLES = ("admin", "standard")
USERNAME_RE = re.compile(r"^[\w.\-@]{1,40}$")  # letters (any alphabet), digits, _ . - @ — no spaces

router = APIRouter(prefix="/api/auth", tags=["auth"])
users_router = APIRouter(prefix="/api/users", tags=["users"])
_sessions: dict[str, dict] = {}


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


class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginBody, response: Response, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    row = conn.execute("SELECT password_hash, role FROM users WHERE username = ?", (body.username,)).fetchone()
    if not row or not bcrypt.checkpw(body.password.encode(), row["password_hash"].encode()):
        raise HTTPException(401, "Nepareizs lietotājvārds vai parole")
    token = secrets.token_urlsafe(32)
    _sessions[token] = {
        "username": body.username,
        "expires_at": datetime.now(timezone.utc) + SESSION_TTL,
    }
    response.set_cookie(
        SESSION_COOKIE, token, httponly=True, samesite="lax",
        max_age=int(SESSION_TTL.total_seconds()),
    )
    return {"username": body.username, "role": row["role"]}


@router.post("/logout")
def logout(response: Response, session: str | None = Cookie(default=None)) -> dict:
    if session:
        _sessions.pop(session, None)
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


def current_username(session: str | None = Cookie(default=None)) -> str:
    entry = _sessions.get(session or "")
    if not entry or entry["expires_at"] < datetime.now(timezone.utc):
        _sessions.pop(session or "", None)
        raise HTTPException(401, "Not logged in")
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

class UserIn(BaseModel):
    username: str
    password: str = Field(min_length=6, max_length=200)
    role: str = "standard"


class UserUpdate(BaseModel):
    password: str | None = Field(default=None, min_length=6, max_length=200)  # None = keep the current one
    role: str | None = None


def _admins(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]


def _drop_sessions(username: str) -> None:
    for token in [t for t, s in _sessions.items() if s["username"] == username]:
        _sessions.pop(token, None)


@users_router.get("")
def list_users(conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT username, role, created_ts, created_by FROM users ORDER BY role != 'admin', username COLLATE NOCASE")]


@users_router.post("", status_code=201)
def create_user(body: UserIn, conn: sqlite3.Connection = Depends(db_dep), admin: str = Depends(require_admin)) -> dict:
    name = body.username.strip()
    if not USERNAME_RE.match(name):
        raise HTTPException(400, "Lietotājvārdā drīkst būt burti, cipari un . _ - @ (bez atstarpēm, līdz 40 zīmēm)")
    if body.role not in ROLES:
        raise HTTPException(400, "Nezināma loma")
    if conn.execute("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE", (name,)).fetchone():
        raise HTTPException(409, "Šāds lietotājs jau ir")
    conn.execute("INSERT INTO users (username, password_hash, role, created_by) VALUES (?,?,?,?)",
                 (name, hash_password(body.password), body.role, admin))
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
            _drop_sessions(username)  # a reset password logs that user out everywhere
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
    _drop_sessions(username)
    return {"deleted": username}
