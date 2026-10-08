"""Toner catalogue (codes), storage locations and per-printer stock.

Stock lives on the printer<->toner link (printer_toners.qty / optimal_qty), matching the Excel
where the same code has a different reserve per printer. Where those cartridges physically are
is tracked per location in stock_locations (see stockloc.py); qty is their sum.
"""

import re
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import empties, stockloc
from .auth import current_username
from .db import db_dep

router = APIRouter(prefix="/api", tags=["toners"])


COLORS = ("", "K", "C", "M", "Y", "CMY")  # CMY: one drum code used for the cyan, magenta and yellow drum
KINDS = ("toner", "drum", "other")


class TonerIn(BaseModel):
    code: str
    color: str = ""
    kind: str = "toner"


def _checked(body: TonerIn) -> tuple[str, str, str]:
    """(code, colour, kind) to store, or 400 for a value the app doesn't know."""
    code, color = body.code.strip(), body.color.strip().upper()
    if not code:
        raise HTTPException(400, "Norādiet kodu")
    if body.kind not in KINDS or color not in COLORS:
        raise HTTPException(400, "Nezināms veids vai krāsa")
    if color == "CMY" and body.kind != "drum":
        raise HTTPException(400, "Krāsu „CMY” var norādīt tikai drumam")
    return code, color, body.kind


class UseIn(BaseModel):
    qty: int = Field(default=1, ge=1, le=1000)
    location_id: int | None = None  # required when the stock is in more than one location
    note: str = ""
    empty_location_id: int | None = None  # where the empty cartridge is put ("Tukšie"); None = not counted


class MoveIn(BaseModel):
    from_location_id: int
    to_location_id: int
    qty: int = Field(ge=1, le=1000)


class CorrectIn(BaseModel):
    counts: dict[int, int]  # location_id -> the actual count there
    reason: str = Field(min_length=1)
    note: str = ""


class OptimalIn(BaseModel):
    optimal_qty: int = Field(ge=0)


class LocationIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    short: str = Field(default="", max_length=20)  # "Saīsinājums": short display name for toner rows
    active: bool = True


# ---- toner catalogue ---------------------------------------------------------------------

@router.get("/toners")
def list_toners(conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT id, code, color, kind FROM toner_models ORDER BY code")]


@router.post("/toners", status_code=201)
def create_toner(body: TonerIn, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    code, color, kind = _checked(body)
    try:
        cur = conn.execute("INSERT INTO toner_models (code, color, kind) VALUES (?,?,?)", (code, color, kind))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Šāds kods jau eksistē")
    return {"id": cur.lastrowid, "code": code, "color": color, "kind": kind}


@router.put("/toners/{toner_id}")
def update_toner(toner_id: int, body: TonerIn, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    code, color, kind = _checked(body)
    try:
        cur = conn.execute("UPDATE toner_models SET code=?, color=?, kind=? WHERE id=?", (code, color, kind, toner_id))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Šāds kods jau eksistē")
    if cur.rowcount == 0:
        raise HTTPException(404, "Toner not found")
    return {"id": toner_id, "code": code, "color": color, "kind": kind}


@router.delete("/toners/{toner_id}")
def delete_toner(toner_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    # Deleting cascades to printer links, stock and log history, so only allow it for unused toners.
    used = conn.execute("SELECT COUNT(*) FROM printer_toners WHERE toner_id = ?", (toner_id,)).fetchone()[0]
    if used:
        raise HTTPException(409, f"Toneri izmanto {used} printeri(-s) — vispirms noņemiet to printeru iestatījumos")
    if not conn.execute("DELETE FROM toner_models WHERE id = ?", (toner_id,)).rowcount:
        raise HTTPException(404, "Toner not found")
    return {"ok": True}


# ---- locations ---------------------------------------------------------------------------

def _location_dict(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    d = dict(row)
    d["active"] = bool(d["active"])
    d["in_stock"] = conn.execute("SELECT COALESCE(SUM(qty), 0) FROM stock_locations WHERE location_id = ?",
                                 (row["id"],)).fetchone()[0]
    return d


@router.get("/locations")
def list_locations(conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    rows = conn.execute("SELECT * FROM locations ORDER BY active DESC, sort, name").fetchall()
    return [_location_dict(conn, r) for r in rows]


@router.post("/locations", status_code=201)
def create_location(body: LocationIn, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    try:
        cur = conn.execute("INSERT INTO locations (name, short, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1"
                           " FROM locations WHERE name <> 'Nav norādīts'))", (body.name.strip(), body.short.strip()))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Šāda vieta jau eksistē")
    return _location_dict(conn, conn.execute("SELECT * FROM locations WHERE id = ?", (cur.lastrowid,)).fetchone())


@router.put("/locations/{location_id}")
def update_location(location_id: int, body: LocationIn, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    current = stockloc.location_or_404(conn, location_id, must_be_active=False)
    if not body.active and current["active"]:
        in_stock = conn.execute("SELECT COALESCE(SUM(qty), 0) FROM stock_locations WHERE location_id = ?",
                                (location_id,)).fetchone()[0]
        if in_stock:
            raise HTTPException(409, f"Vietā vēl ir {in_stock} gab. — vispirms pārvietojiet tos")
        empty = conn.execute("SELECT COALESCE(SUM(qty), 0) FROM empties WHERE location_id = ?", (location_id,)).fetchone()[0]
        if empty:
            raise HTTPException(409, f"Vietā vēl ir {empty} tukšie — vispirms atdodiet vai pārvietojiet tos (Vēsture → Tukšie)")
    try:
        conn.execute("UPDATE locations SET name = ?, short = ?, active = ? WHERE id = ?",
                     (body.name.strip(), body.short.strip(), int(body.active), location_id))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Šāda vieta jau eksistē")
    if not body.active:
        conn.execute("UPDATE printers SET default_location_id = NULL WHERE default_location_id = ?", (location_id,))
        conn.execute("UPDATE printers SET empties_location_id = NULL WHERE empties_location_id = ?", (location_id,))
    return _location_dict(conn, conn.execute("SELECT * FROM locations WHERE id = ?", (location_id,)).fetchone())


# ---- stock -------------------------------------------------------------------------------

_STOCK_SQL = """
SELECT pt.printer_id, p.company, p.location, p.model, p.ip, p.default_location_id, p.empties_location_id, p.active,
       pt.toner_id, t.code, t.color, t.kind, pt.qty, pt.optimal_qty,
       pt.qty < pt.optimal_qty AS low,
       (SELECT COALESCE(SUM(o.qty), 0) FROM orders o WHERE o.status = 'ordered'
          AND o.printer_id = pt.printer_id AND o.toner_id = pt.toner_id) AS ordered,
       -- of those, ordered as extras from the basket: they don't count towards the norm
       (SELECT COALESCE(SUM(o.qty), 0) FROM orders o WHERE o.status = 'ordered' AND o.extra = 1
          AND o.printer_id = pt.printer_id AND o.toner_id = pt.toner_id) AS ordered_extra
FROM printer_toners pt
JOIN printers p ON p.id = pt.printer_id
JOIN toner_models t ON t.id = pt.toner_id
"""


def _stock_dict(row: sqlite3.Row, locs: dict) -> dict:
    d = dict(row)
    d["low"] = bool(d["low"])
    d["active"] = bool(d["active"])
    d["locations"] = locs.get((d["printer_id"], d["toner_id"]), [])
    return d


def _stock_row(conn: sqlite3.Connection, printer_id: int, toner_id: int) -> dict:
    row = conn.execute(_STOCK_SQL + " WHERE pt.printer_id = ? AND pt.toner_id = ?",
                       (printer_id, toner_id)).fetchone()
    if not row:
        raise HTTPException(404, "Printer/toner link not found")
    return _stock_dict(row, stockloc.breakdown(conn))


@router.get("/stock")
def list_stock(conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    locs = stockloc.breakdown(conn)
    # Within a printer: toners, then drums, then the rest; each in K, C, M, Y order (as in the printer's details).
    return [_stock_dict(r, locs) for r in conn.execute(
        _STOCK_SQL + " ORDER BY p.company, p.location,"
        " CASE t.kind WHEN 'toner' THEN 0 WHEN 'drum' THEN 1 ELSE 2 END,"
        " CASE UPPER(t.color) WHEN 'K' THEN 0 WHEN 'C' THEN 1 WHEN 'M' THEN 2 WHEN 'Y' THEN 3 WHEN 'CMY' THEN 4 ELSE 9 END,"
        " t.code")]


@router.post("/stock/{printer_id}/{toner_id}/use")
def use_stock(printer_id: int, toner_id: int, body: UseIn,
              conn: sqlite3.Connection = Depends(db_dep),
              username: str = Depends(current_username)) -> dict:
    """Mark cartridges as used/removed from one location. Stock only grows via received orders or corrections."""
    current = _stock_row(conn, printer_id, toner_id)
    loc = body.location_id
    if loc is None:
        places = current["locations"]
        if not places:
            raise HTTPException(400, "Krājumā nav neviena")
        if len(places) > 1:
            raise HTTPException(400, "Norādiet, no kuras vietas")
        loc = places[0]["location_id"]
    stockloc.location_or_404(conn, loc, must_be_active=False)
    if stockloc.qty_at(conn, printer_id, toner_id, loc) < body.qty:
        raise HTTPException(400, "Šajā vietā nav pietiekami daudz")
    stockloc.add(conn, printer_id, toner_id, loc, -body.qty)
    stockloc.sync_total(conn, printer_id, toner_id)
    movement = stockloc.log(conn, toner_id=toner_id, printer_id=printer_id, delta=-body.qty, reason="taken",
                            username=username, note=body.note, location_id=loc)
    empties.from_used(conn, toner_id=toner_id, location_id=body.empty_location_id, qty=body.qty, username=username,
                      movement_id=movement, printer=current["location"])
    return {**_stock_row(conn, printer_id, toner_id), "movement_id": movement}  # movement_id: for "Atsaukt"


@router.post("/stock/{printer_id}/{toner_id}/move")
def move_stock(printer_id: int, toner_id: int, body: MoveIn,
               conn: sqlite3.Connection = Depends(db_dep),
               username: str = Depends(current_username)) -> dict:
    """Move cartridges between locations; the total doesn't change."""
    _stock_row(conn, printer_id, toner_id)
    if body.from_location_id == body.to_location_id:
        raise HTTPException(400, "Izvēlieties citu vietu")
    stockloc.location_or_404(conn, body.from_location_id, must_be_active=False)
    stockloc.location_or_404(conn, body.to_location_id)
    if stockloc.qty_at(conn, printer_id, toner_id, body.from_location_id) < body.qty:
        raise HTTPException(400, "Šajā vietā nav pietiekami daudz")
    stockloc.add(conn, printer_id, toner_id, body.from_location_id, -body.qty)
    stockloc.add(conn, printer_id, toner_id, body.to_location_id, body.qty)
    stockloc.sync_total(conn, printer_id, toner_id)
    stockloc.log(conn, toner_id=toner_id, printer_id=printer_id, delta=body.qty, reason="moved",
                 username=username, location_id=body.from_location_id, to_location_id=body.to_location_id)
    return _stock_row(conn, printer_id, toner_id)


@router.post("/stock/{printer_id}/{toner_id}/correct")
def correct_stock(printer_id: int, toner_id: int, body: CorrectIn,
                  conn: sqlite3.Connection = Depends(db_dep),
                  username: str = Depends(current_username)) -> dict:
    """Set the actual count per location (e.g. after a stock-take). One log entry per changed location."""
    _stock_row(conn, printer_id, toner_id)
    note = body.reason.strip() + (f": {body.note.strip()}" if body.note.strip() else "")
    changed = 0
    for loc, new in body.counts.items():
        if new < 0 or new > 1000:
            raise HTTPException(400, "Skaitam jābūt no 0 līdz 1000")
        current = stockloc.qty_at(conn, printer_id, toner_id, loc)
        if new == current:
            continue
        # Adding stock needs an active location; taking it out of an archived one is fine.
        stockloc.location_or_404(conn, loc, must_be_active=new > current)
        stockloc.add(conn, printer_id, toner_id, loc, new - current)
        stockloc.log(conn, toner_id=toner_id, printer_id=printer_id, delta=new - current, reason="correction",
                     username=username, note=note, location_id=loc)
        changed += 1
    if not changed:
        raise HTTPException(400, "Nav izmaiņu")
    stockloc.sync_total(conn, printer_id, toner_id)
    return _stock_row(conn, printer_id, toner_id)


@router.put("/stock/{printer_id}/{toner_id}/optimal")
def set_optimal(printer_id: int, toner_id: int, body: OptimalIn,
                conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    _stock_row(conn, printer_id, toner_id)
    conn.execute("UPDATE printer_toners SET optimal_qty = ? WHERE printer_id = ? AND toner_id = ?",
                 (body.optimal_qty, printer_id, toner_id))
    return _stock_row(conn, printer_id, toner_id)


# ---- log ---------------------------------------------------------------------------------

@router.delete("/movements/{movement_id}")
def delete_movement(movement_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    """Removes only the log entry; current stock quantities are not changed."""
    if not conn.execute("DELETE FROM stock_movements WHERE id = ?", (movement_id,)).rowcount:
        raise HTTPException(404, "Movement not found")
    return {"ok": True}


UNDO_SECONDS = 300  # "Atsaukt" is for a slip right after the action, not for rewriting history


class UndoIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=200)  # history entries of one action ("Saņemt visus" has several)


@router.post("/movements/undo")
def undo_movements(body: UndoIn, conn: sqlite3.Connection = Depends(db_dep),
                   username: str = Depends(current_username)) -> dict:
    """"Atsaukt" right after "Izlietots" or "Saņemt": put the reserve back as it was and remove the history
    entry; a received order goes back to "Pasūtīts". Only your own action, only within UNDO_SECONDS, and only
    these two kinds (a confirmed replacement is undone by correcting the quantity). All or nothing."""
    for mid in dict.fromkeys(body.ids):
        m = conn.execute(
            "SELECT *, (julianday('now', 'localtime') - julianday(ts)) * 86400 AS age FROM stock_movements WHERE id = ?",
            (mid,)).fetchone()
        if not m:
            raise HTTPException(404, "Darbība vairs nav atrodama")
        if (m["username"] != username or m["reason"] not in ("taken", "received") or m["age"] > UNDO_SECONDS
                or m["printer_id"] is None or m["location_id"] is None or m["note"].startswith("Nomainīts (SNMP")):
            raise HTTPException(409, "Šo darbību vairs nevar atsaukt")
        pid, tid, loc, delta = m["printer_id"], m["toner_id"], m["location_id"], m["delta"]
        if delta > 0 and stockloc.qty_at(conn, pid, tid, loc) < delta:
            raise HTTPException(409, "Saņemtie toneri no šīs vietas jau ir izlietoti vai pārvietoti")
        stockloc.add(conn, pid, tid, loc, -delta)
        stockloc.sync_total(conn, pid, tid)
        empties.undo_used(conn, mid)  # the empty cartridge it put on the "Tukšie" list, if any
        if m["reason"] == "received":  # the order it came from is open again
            ref = re.search(r"#(\d+)", m["note"])
            if ref:
                conn.execute(
                    "UPDATE orders SET status = 'ordered', received_qty = NULL, resolved_by = NULL, resolved_ts = NULL"
                    " WHERE id = ? AND status = 'received' AND printer_id = ? AND toner_id = ?", (int(ref.group(1)), pid, tid))
        conn.execute("DELETE FROM stock_movements WHERE id = ?", (mid,))
    return {"undone": len(set(body.ids))}


@router.get("/movements")
def movements(limit: int = 500, conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    rows = conn.execute(
        "SELECT m.id, m.ts, m.delta, m.reason, m.username, m.note, t.code AS toner_code, t.color AS toner_color,"
        " t.kind AS toner_kind,"
        " p.location AS printer_location, lf.name AS location, lt.name AS to_location"
        " FROM stock_movements m"
        " JOIN toner_models t ON t.id = m.toner_id LEFT JOIN printers p ON p.id = m.printer_id"
        " LEFT JOIN locations lf ON lf.id = m.location_id LEFT JOIN locations lt ON lt.id = m.to_location_id"
        " ORDER BY m.ts DESC, m.id DESC LIMIT ?", (min(limit, 1000),))
    return [dict(r) for r in rows]
