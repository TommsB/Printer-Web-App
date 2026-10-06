"""Toner catalogue (codes), storage locations and per-printer stock.

Stock lives on the printer<->toner link (printer_toners.qty / optimal_qty), matching the Excel
where the same code has a different reserve per printer. Where those cartridges physically are
is tracked per location in stock_locations (see stockloc.py); qty is their sum.
"""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import stockloc
from .auth import current_username
from .db import db_dep

router = APIRouter(prefix="/api", tags=["toners"])


class TonerIn(BaseModel):
    code: str
    color: str = ""
    kind: str = "toner"


class UseIn(BaseModel):
    qty: int = Field(default=1, ge=1, le=1000)
    location_id: int | None = None  # required when the stock is in more than one location
    note: str = ""


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
    try:
        cur = conn.execute("INSERT INTO toner_models (code, color, kind) VALUES (?,?,?)",
                           (body.code.strip(), body.color, body.kind))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Šāds toneris jau eksistē")
    return {"id": cur.lastrowid, **body.model_dump()}


@router.put("/toners/{toner_id}")
def update_toner(toner_id: int, body: TonerIn, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    try:
        cur = conn.execute("UPDATE toner_models SET code=?, color=?, kind=? WHERE id=?",
                           (body.code.strip(), body.color, body.kind, toner_id))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Šāds toneris jau eksistē")
    if cur.rowcount == 0:
        raise HTTPException(404, "Toner not found")
    return {"id": toner_id, **body.model_dump()}


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
    try:
        conn.execute("UPDATE locations SET name = ?, short = ?, active = ? WHERE id = ?",
                     (body.name.strip(), body.short.strip(), int(body.active), location_id))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Šāda vieta jau eksistē")
    if not body.active:
        conn.execute("UPDATE printers SET default_location_id = NULL WHERE default_location_id = ?", (location_id,))
    return _location_dict(conn, conn.execute("SELECT * FROM locations WHERE id = ?", (location_id,)).fetchone())


# ---- stock -------------------------------------------------------------------------------

_STOCK_SQL = """
SELECT pt.printer_id, p.company, p.location, p.model, p.ip, p.default_location_id,
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
    return [_stock_dict(r, locs) for r in conn.execute(_STOCK_SQL + " ORDER BY p.company, p.location, t.code")]


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
    stockloc.log(conn, toner_id=toner_id, printer_id=printer_id, delta=-body.qty, reason="taken",
                 username=username, note=body.note, location_id=loc)
    return _stock_row(conn, printer_id, toner_id)


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


@router.get("/movements")
def movements(limit: int = 500, conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    rows = conn.execute(
        "SELECT m.id, m.ts, m.delta, m.reason, m.username, m.note, t.code AS toner_code, t.color AS toner_color,"
        " p.location AS printer_location, lf.name AS location, lt.name AS to_location"
        " FROM stock_movements m"
        " JOIN toner_models t ON t.id = m.toner_id LEFT JOIN printers p ON p.id = m.printer_id"
        " LEFT JOIN locations lf ON lf.id = m.location_id LEFT JOIN locations lt ON lt.id = m.to_location_id"
        " ORDER BY m.ts DESC, m.id DESC LIMIT ?", (min(limit, 1000),))
    return [dict(r) for r in rows]
