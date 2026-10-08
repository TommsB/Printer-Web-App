"""Empty cartridges ("Tukšie"): how many used-up toners and drums are lying where, until they are handed back
to the supplier.

Counted per storage location and per kind only (toner / drum) — not per code: an empty is an empty. One is
added when a cartridge is marked used ("Izlietots", or a confirmed replacement) and the user says where the
empty one goes; the printer's own default place for empties is pre-selected there. From the list they are
handed back ("Atdot"), moved between places ("Lokācija") or counted again ("Labot daudzumu").
Every change is written to empties_log.
"""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import stockloc
from .auth import current_username
from .db import db_dep

router = APIRouter(prefix="/api/empties", tags=["empties"])

KINDS = ("toner", "drum")  # other consumables leave no empties worth counting
LOG_SHOWN = 40


def qty_at(conn: sqlite3.Connection, location_id: int, kind: str) -> int:
    row = conn.execute("SELECT qty FROM empties WHERE location_id = ? AND kind = ?", (location_id, kind)).fetchone()
    return row["qty"] if row else 0


def _set(conn: sqlite3.Connection, location_id: int, kind: str, qty: int) -> None:
    """Store the count at one place (a place with none has no row)."""
    if qty > 0:
        conn.execute("INSERT INTO empties (location_id, kind, qty) VALUES (?,?,?)"
                     " ON CONFLICT(location_id, kind) DO UPDATE SET qty = excluded.qty", (location_id, kind, qty))
    else:
        conn.execute("DELETE FROM empties WHERE location_id = ? AND kind = ?", (location_id, kind))


def change(conn: sqlite3.Connection, *, location_id: int, kind: str, delta: int, reason: str, username: str,
           note: str = "", to_location_id: int | None = None, movement_id: int | None = None) -> None:
    """Add `delta` (may be negative) at one place and log it. Callers check that enough is there."""
    _set(conn, location_id, kind, qty_at(conn, location_id, kind) + delta)
    conn.execute(
        "INSERT INTO empties_log (username, kind, location_id, to_location_id, delta, reason, note, movement_id)"
        " VALUES (?,?,?,?,?,?,?,?)", (username, kind, location_id, to_location_id, delta, reason, note.strip(), movement_id))


def from_used(conn: sqlite3.Connection, *, toner_id: int, location_id: int | None, qty: int, username: str,
              movement_id: int, printer: str) -> None:
    """A cartridge was just marked used: put its empty at `location_id` (None = don't count it). Tied to the
    stock movement, so "Atsaukt" takes the empty away again."""
    if location_id is None:
        return
    kind = conn.execute("SELECT kind FROM toner_models WHERE id = ?", (toner_id,)).fetchone()["kind"]
    if kind not in KINDS:
        return
    stockloc.location_or_404(conn, location_id)
    change(conn, location_id=location_id, kind=kind, delta=qty, reason="used", username=username,
           note=printer, movement_id=movement_id)


def undo_used(conn: sqlite3.Connection, movement_id: int) -> None:
    """The "Izlietots" behind these empties was taken back: remove them (as far as they are still there)."""
    for r in conn.execute("SELECT id, kind, location_id, delta FROM empties_log WHERE movement_id = ?", (movement_id,)).fetchall():
        _set(conn, r["location_id"], r["kind"], qty_at(conn, r["location_id"], r["kind"]) - r["delta"])
        conn.execute("DELETE FROM empties_log WHERE id = ?", (r["id"],))


@router.get("")
def overview(conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    """What is where (`rows`, by place then kind) and the latest changes (`log`, newest first)."""
    rows = [dict(r) for r in conn.execute(
        "SELECT e.location_id, l.name AS location, e.kind, e.qty FROM empties e JOIN locations l ON l.id = e.location_id"
        " WHERE e.qty > 0 ORDER BY l.sort, l.name, CASE e.kind WHEN 'toner' THEN 0 ELSE 1 END")]
    log = [dict(r) for r in conn.execute(
        "SELECT g.id, g.ts, g.username, g.kind, g.delta, g.reason, g.note, l.name AS location, t.name AS to_location"
        " FROM empties_log g LEFT JOIN locations l ON l.id = g.location_id LEFT JOIN locations t ON t.id = g.to_location_id"
        " ORDER BY g.id DESC LIMIT ?", (LOG_SHOWN,))]
    return {"rows": rows, "log": log}


def _kind(kind: str) -> str:
    if kind not in KINDS:
        raise HTTPException(400, "Nezināms veids")
    return kind


class ReturnIn(BaseModel):
    location_id: int
    kind: str
    qty: int = Field(ge=1, le=10000)
    note: str = Field(default="", max_length=200)


@router.post("/return")
def give_back(body: ReturnIn, conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    """"Atdot": that many empties left this place for the supplier."""
    if qty_at(conn, body.location_id, _kind(body.kind)) < body.qty:
        raise HTTPException(400, "Šajā vietā nav tik daudz tukšo")
    change(conn, location_id=body.location_id, kind=body.kind, delta=-body.qty, reason="returned", username=username, note=body.note)
    return overview(conn)


class MoveIn(BaseModel):
    from_location_id: int
    to_location_id: int
    kind: str
    qty: int = Field(ge=1, le=10000)


@router.post("/move")
def move(body: MoveIn, conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    """"Lokācija": empties carried from one place to another; the total doesn't change."""
    if body.from_location_id == body.to_location_id:
        raise HTTPException(400, "Izvēlieties citu vietu")
    stockloc.location_or_404(conn, body.to_location_id)
    if qty_at(conn, body.from_location_id, _kind(body.kind)) < body.qty:
        raise HTTPException(400, "Šajā vietā nav tik daudz tukšo")
    _set(conn, body.from_location_id, body.kind, qty_at(conn, body.from_location_id, body.kind) - body.qty)
    _set(conn, body.to_location_id, body.kind, qty_at(conn, body.to_location_id, body.kind) + body.qty)
    conn.execute("INSERT INTO empties_log (username, kind, location_id, to_location_id, delta, reason) VALUES (?,?,?,?,?,'moved')",
                 (username, body.kind, body.from_location_id, body.to_location_id, body.qty))
    return overview(conn)


class CorrectIn(BaseModel):
    location_id: int
    kind: str
    qty: int = Field(ge=0, le=10000)  # how many are really there
    note: str = Field(default="", max_length=200)


@router.post("/correct")
def correct(body: CorrectIn, conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    """"Labot daudzumu": set the real count at a place (also how a first count is entered)."""
    stockloc.location_or_404(conn, body.location_id, must_be_active=False)
    delta = body.qty - qty_at(conn, body.location_id, _kind(body.kind))
    if delta:
        _set(conn, body.location_id, body.kind, body.qty)
        conn.execute("INSERT INTO empties_log (username, kind, location_id, delta, reason, note) VALUES (?,?,?,?,'correction',?)",
                     (username, body.kind, body.location_id, delta, body.note.strip()))
    return overview(conn)
