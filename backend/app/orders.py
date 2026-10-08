"""Toner orders: (planned ->) ordered -> received (adds to the reserve) or cancelled.

'planned' = in the basket ("Grozs"): cartridges someone added by hand, on top of what the app suggests there
from the norms. Nothing is ordered until the basket is ordered; then they become 'ordered'.

Stock only increases when an order is marked received; nothing is added by ordering.

A warranty claim (`warranty` = 1) is the same thing without a purchase, with one stage before it:
defect (on the "Defekti" list) -> ordered ("Nodots garantijā": handed over, replacement expected)
-> received (replacement arrived) or cancelled (claim rejected).
"""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import attachments, stockloc
from .auth import current_username
from .db import db_dep

router = APIRouter(prefix="/api/orders", tags=["orders"])


class OrderItem(BaseModel):
    printer_id: int
    toner_id: int
    qty: int = Field(ge=1, le=1000)


class OrderIn(BaseModel):
    items: list[OrderItem] = Field(min_length=1, max_length=100)
    note: str = ""
    planned: bool = False  # True = only put it in the basket ("Grozs"); nothing is ordered yet
    extra: bool = False  # True = this order is the basket's "papildus" part for these toners (uses it up)


class ReceiveIn(BaseModel):
    qty: int | None = Field(default=None, ge=1, le=1000)  # defaults to the ordered quantity
    location_id: int | None = None  # where the cartridges are put; defaults to the printer's default location


_SQL = """
SELECT o.id, o.printer_id, o.toner_id, o.qty, o.status, o.note, o.created_by, o.created_ts,
       o.resolved_by, o.resolved_ts, o.received_qty, o.warranty, o.removed_pct, o.defect, o.sent_ts, o.sent_by,
       p.location, p.model, p.company, p.default_location_id, t.code, t.color, t.kind,
       o.pages_printed, o.installed_ts, o.held_location_id, h.name AS held_at,
       (SELECT COUNT(*) FROM order_files f WHERE f.order_id = o.id) AS files
FROM orders o
JOIN printers p ON p.id = o.printer_id
JOIN toner_models t ON t.id = o.toner_id
LEFT JOIN locations h ON h.id = o.held_location_id
"""


def _get(conn: sqlite3.Connection, order_id: int) -> sqlite3.Row:
    row = conn.execute(_SQL + " WHERE o.id = ?", (order_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Order not found")
    return row


@router.get("")
def list_orders(status: str = "ordered", conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    if status not in ("planned", "ordered", "received", "cancelled", "defect", "all"):
        raise HTTPException(400, "bad status")
    where, args = ("", ()) if status == "all" else (" WHERE o.status = ?", (status,))
    rows = conn.execute(_SQL + where + " ORDER BY o.created_ts DESC, o.id DESC LIMIT 500", args)
    docs = attachments.docs_by_order(conn)  # delivery notes etc., shared by the orders they cover
    return [{**dict(r), "docs": docs.get(r["id"], [])} for r in rows]


@router.post("", status_code=201)
def create_orders(body: OrderIn, conn: sqlite3.Connection = Depends(db_dep),
                  username: str = Depends(current_username)) -> list[dict]:
    """Three uses.
    `planned`: put cartridges in the basket ("Grozs", status 'planned') — extra ones, on top of what is missing
    to the norm; nothing is ordered, and adding the same toner again adds to its quantity.
    `extra`: order the basket's extra part for these toners — the basket entries are used up, and the order is
    marked `extra`, so it doesn't count towards the norm (what is missing to the norm stays in the basket).
    Neither: an ordinary order (the part missing to the norm); the basket's extra entries are left alone."""
    ids = []
    note = body.note.strip()
    for it in body.items:
        if not conn.execute("SELECT 1 FROM printer_toners WHERE printer_id = ? AND toner_id = ?",
                            (it.printer_id, it.toner_id)).fetchone():
            raise HTTPException(404, "Printer/toner link not found")
        basket = conn.execute("SELECT id, qty, note FROM orders WHERE status = 'planned' AND printer_id = ? AND toner_id = ?",
                              (it.printer_id, it.toner_id)).fetchall()
        if body.planned and basket:
            if basket[0]["qty"] + it.qty > 1000:
                raise HTTPException(400, "Grozā nevar būt vairāk par 1000 gab. viena tonera")
            conn.execute("UPDATE orders SET qty = qty + ?, note = CASE WHEN ? != '' THEN ? ELSE note END WHERE id = ?",
                         (it.qty, note, note, basket[0]["id"]))
            ids.append(basket[0]["id"])
            continue
        kept = ""
        if body.extra and not body.planned:  # the basket entries become this order; their notes come along
            kept = "; ".join(dict.fromkeys(b["note"] for b in basket if b["note"]))
            conn.execute("DELETE FROM orders WHERE status = 'planned' AND printer_id = ? AND toner_id = ?",
                         (it.printer_id, it.toner_id))
        cur = conn.execute(
            "INSERT INTO orders (printer_id, toner_id, qty, status, note, created_by, extra) VALUES (?,?,?,?,?,?,?)",
            (it.printer_id, it.toner_id, it.qty, "planned" if body.planned else "ordered",
             note or kept, username, int(body.extra and not body.planned)))
        ids.append(cur.lastrowid)
    return [dict(_get(conn, i)) for i in ids]


def _receive(conn: sqlite3.Connection, order_id: int, qty: int | None, location_id: int | None, username: str) -> int:
    """Mark one open order received: qty (default: as ordered) goes into the reserve at the location
    (default: the printer's default one) and is logged. Returns the history entry's id (for "Atsaukt")."""
    order = _get(conn, order_id)
    if order["status"] != "ordered":
        raise HTTPException(409, f"Pasūtījums {order['code']} jau ir apstrādāts")
    qty = qty or order["qty"]
    loc = location_id or order["default_location_id"]
    if loc is None:
        raise HTTPException(400, f"Norādiet, kur novietot {order['code']} ({order['location']})")
    stockloc.location_or_404(conn, loc)
    conn.execute(
        "UPDATE orders SET status='received', received_qty=?, resolved_by=?,"
        " resolved_ts=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id=?",
        (qty, username, order_id))
    stockloc.add(conn, order["printer_id"], order["toner_id"], loc, qty)
    stockloc.sync_total(conn, order["printer_id"], order["toner_id"])
    # The "#id" in the note is how an undo finds the order again (toners.undo_movements).
    return stockloc.log(conn, toner_id=order["toner_id"], printer_id=order["printer_id"], delta=qty, reason="received",
                        username=username, location_id=loc,
                        note=f"Garantijas aizvietotājs #{order_id}" if order["warranty"] else f"Pasūtījums #{order_id}")


class WarrantyIn(BaseModel):
    printer_id: int
    toner_id: int
    removed_pct: int | None = Field(default=None, ge=0, le=100)  # level when it was taken out, if known
    defect: str = Field(default="", max_length=200)
    note: str = Field(default="", max_length=500)
    held_location_id: int | None = None  # where the defective cartridge is kept until it is handed over
    event_id: int | None = None  # from "Jāpārbauda": the detected replacement that took this cartridge out


def _counter_at(conn: sqlite3.Connection, printer_id: int, ts: str) -> int | None:
    """The printer's page counter at a moment: the last reading up to then — exact while the readings are
    still kept, else the end of that day (page_counts)."""
    row = conn.execute(
        "SELECT page_count FROM snmp_snapshots WHERE printer_id = ? AND reachable = 1 AND page_count IS NOT NULL"
        " AND ts <= ? ORDER BY ts DESC LIMIT 1", (printer_id, ts)).fetchone()
    if not row:
        row = conn.execute("SELECT page_count FROM page_counts WHERE printer_id = ? AND day <= ? ORDER BY day DESC LIMIT 1",
                           (printer_id, ts[:10])).fetchone()
    return row["page_count"] if row else None


def cartridge_life(conn: sqlite3.Connection, printer_id: int, toner_id: int, event_id: int | None) -> tuple[str | None, int | None]:
    """(when the defective cartridge was put in, pages printed with it) — None where it isn't known.

    Put in = the detected replacement (toner_events) of that colour before it came out. Taken out = the
    replacement being reviewed (`event_id`, from "Jāpārbauda"), or now when it is marked from a toner's menu.
    Pages = the page counter then minus the counter when it went in (all colours and mono pages together:
    it is how much the printer printed while this cartridge was in it).
    """
    color, kind = conn.execute("SELECT UPPER(color), kind FROM toner_models WHERE id = ?", (toner_id,)).fetchone()
    # Same colour only counts within the same kind: a black drum's replacement says nothing about the black toner.
    same = "printer_id = ? AND (toner_id = ? OR (color != '' AND color = ? AND kind = ?))"
    removed_ts = conn.execute("SELECT strftime('%Y-%m-%dT%H:%M:%S','now','localtime')").fetchone()[0]
    before = ""
    args: tuple = (printer_id, toner_id, color, kind)
    if event_id is not None:
        ev = conn.execute("SELECT ts FROM toner_events WHERE id = ? AND printer_id = ?", (event_id, printer_id)).fetchone()
        if ev:
            removed_ts, before, args = ev["ts"], " AND id < ?", (*args, event_id)
    put_in = conn.execute(f"SELECT ts FROM toner_events WHERE {same}{before} ORDER BY id DESC LIMIT 1", args).fetchone()
    if not put_in:
        return None, None
    start, end = _counter_at(conn, printer_id, put_in["ts"]), _counter_at(conn, printer_id, removed_ts)
    pages = end - start if start is not None and end is not None and end >= start else None
    return put_in["ts"], pages


@router.post("/warranty", status_code=201)
def create_warranty(body: WarrantyIn, conn: sqlite3.Connection = Depends(db_dep),
                    username: str = Depends(current_username)) -> dict:
    """Put a defective cartridge on the "Defekti" list (status 'defect'). Nothing is expected yet, so it does
    not count as 'on order', and the reserve does not change (the cartridge came out of the printer, not the
    shelf). "Nodots garantijā" (send_warranty) moves it on to the open orders."""
    if not conn.execute("SELECT 1 FROM printer_toners WHERE printer_id = ? AND toner_id = ?",
                        (body.printer_id, body.toner_id)).fetchone():
        raise HTTPException(404, "Printer/toner link not found")
    if body.held_location_id is not None:
        stockloc.location_or_404(conn, body.held_location_id)
    installed_ts, pages = cartridge_life(conn, body.printer_id, body.toner_id, body.event_id)
    cur = conn.execute(
        "INSERT INTO orders (printer_id, toner_id, qty, status, note, created_by, warranty, removed_pct, defect,"
        " held_location_id, installed_ts, pages_printed) VALUES (?,?,1,'defect',?,?,1,?,?,?,?,?)",
        (body.printer_id, body.toner_id, body.note.strip(), username, body.removed_pct, body.defect.strip(),
         body.held_location_id, installed_ts, pages))
    return dict(_get(conn, cur.lastrowid))


class HeldIn(BaseModel):
    location_id: int | None = None  # None = not recorded


@router.put("/{order_id}/held")
def set_held(order_id: int, body: HeldIn, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    """Where the defective cartridge is kept (it can be moved before it is handed over)."""
    if not _get(conn, order_id)["warranty"]:
        raise HTTPException(400, "Tikai defektiem")
    if body.location_id is not None:
        stockloc.location_or_404(conn, body.location_id)
    conn.execute("UPDATE orders SET held_location_id = ? WHERE id = ?", (body.location_id, order_id))
    return dict(_get(conn, order_id))


@router.get("/defects")
def list_defects(printer_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    """Every defect recorded for one printer, newest first (the printer's info view)."""
    return [dict(r) for r in conn.execute(
        _SQL + " WHERE o.warranty = 1 AND o.printer_id = ? ORDER BY o.created_ts DESC, o.id DESC", (printer_id,))]


@router.post("/{order_id}/send")
def send_warranty(order_id: int, conn: sqlite3.Connection = Depends(db_dep),
                  username: str = Depends(current_username)) -> dict:
    """"Nodots garantijā": the defective cartridge was handed over. From now a replacement is expected — the
    claim is an open order (counts as 'on order') until it is received or rejected."""
    order = _get(conn, order_id)
    if order["status"] != "defect":
        raise HTTPException(409, "Šis ieraksts jau ir nodots garantijā vai slēgts")
    conn.execute(
        "UPDATE orders SET status='ordered', sent_by=?,"
        " sent_ts=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id=?", (username, order_id))
    return dict(_get(conn, order_id))


class ReceiveManyItem(BaseModel):
    id: int
    location_id: int | None = None  # None = the printer's default location


class ReceiveManyIn(BaseModel):
    items: list[ReceiveManyItem] = Field(min_length=1, max_length=200)


@router.post("/receive-all")
def receive_many(body: ReceiveManyIn, conn: sqlite3.Connection = Depends(db_dep),
                 username: str = Depends(current_username)) -> list[dict]:
    """'Saņemt visus': receive several open orders at their full ordered quantity. All or nothing —
    any error (already handled, no location) raises, and the request's transaction is rolled back."""
    ids = [it.id for it in body.items]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "Pasūtījums norādīts divreiz")
    moved = {it.id: _receive(conn, it.id, None, it.location_id, username) for it in body.items}
    return [{**dict(_get(conn, i)), "movement_id": moved[i]} for i in ids]


@router.post("/{order_id}/receive")
def receive_order(order_id: int, body: ReceiveIn, conn: sqlite3.Connection = Depends(db_dep),
                  username: str = Depends(current_username)) -> dict:
    movement = _receive(conn, order_id, body.qty, body.location_id, username)
    return {**dict(_get(conn, order_id)), "movement_id": movement}


class QtyIn(BaseModel):
    qty: int = Field(ge=1, le=1000)


@router.put("/{order_id}/qty")
def set_basket_qty(order_id: int, body: QtyIn, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    """Change how many of a toner were added to the basket by hand. Only for basket entries: a placed order's
    quantity is what was ordered."""
    if _get(conn, order_id)["status"] != "planned":
        raise HTTPException(409, "Daudzumu var mainīt tikai grozā")
    conn.execute("UPDATE orders SET qty = ? WHERE id = ?", (body.qty, order_id))
    return dict(_get(conn, order_id))


@router.delete("/{order_id}")
def delete_order(order_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    """Remove an order record from the history. Stock is not touched: cartridges already received stay in the
    reserve (and their 'Saņemts' movement stays in the log); an open order just stops counting as ordered."""
    _get(conn, order_id)  # 404 if it doesn't exist
    attachments.remove_for_order(conn, order_id)  # a defect's photos go with it
    conn.execute("DELETE FROM orders WHERE id = ?", (order_id,))
    return {"deleted": order_id}


@router.post("/{order_id}/cancel")
def cancel_order(order_id: int, conn: sqlite3.Connection = Depends(db_dep),
                 username: str = Depends(current_username)) -> dict:
    order = _get(conn, order_id)
    if order["status"] != "ordered":
        raise HTTPException(409, "Pasūtījums jau ir apstrādāts")
    conn.execute(
        "UPDATE orders SET status='cancelled', resolved_by=?,"
        " resolved_ts=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id=?",
        (username, order_id))
    return dict(_get(conn, order_id))
