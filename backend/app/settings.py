"""Small per-user settings (key -> text), e.g. the order e-mail template. The value is opaque to the server."""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import current_username
from .db import db_dep

router = APIRouter(prefix="/api/settings", tags=["settings"])

KEYS = {"order_email", "warranty_email"}  # known settings; anything else is rejected


class SettingIn(BaseModel):
    value: str = Field(max_length=20_000)


def _check(key: str) -> None:
    if key not in KEYS:
        raise HTTPException(404, "Unknown setting")


@router.get("/{key}")
def get_setting(key: str, conn: sqlite3.Connection = Depends(db_dep),
                username: str = Depends(current_username)) -> dict:
    _check(key)
    row = conn.execute("SELECT value FROM user_settings WHERE username = ? AND key = ?", (username, key)).fetchone()
    return {"value": row["value"] if row else None}  # None = not set, the app uses its default


@router.put("/{key}")
def put_setting(key: str, body: SettingIn, conn: sqlite3.Connection = Depends(db_dep),
                username: str = Depends(current_username)) -> dict:
    _check(key)
    conn.execute("INSERT INTO user_settings (username, key, value) VALUES (?,?,?)"
                 " ON CONFLICT(username, key) DO UPDATE SET value = excluded.value", (username, key, body.value))
    return {"value": body.value}
