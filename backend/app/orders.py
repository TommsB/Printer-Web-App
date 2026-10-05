"""Toner orders: ordered -> received (adds to the reserve) or cancelled.

Stock only increases when an order is marked received; nothing is added by ordering.

A warranty claim (`warranty` = 1) is the same thing without a purchase, with one stage before it:
defect (on the "Defekti" list) -> ordered ("Nodots garantijā": handed over, replacement expected)
-> received (replacement arrived) or cancelled (claim rejected).
"""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import stockloc
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


class ReceiveIn(BaseModel):
    qty: int | None = Field(default=None, ge=1, le=1000)  # defaults to the ordered quantity
    location_id: int | None = None  # where the cartridges are put; defaults to the printer's default location


_SQL = """
SELECT o.id, o.printer_id, o.toner_id, o.qty, o.status, o.note, o.created_by, o.created_ts,
       o.resolved_by, o.resolved_ts, o.received_qty, o.warranty, o.removed_pct, o.defect, o.sent_ts, o.sent_by,
       p.location, p.model, p.company, p.default_location_id, t.code, t.color, t.kind
FROM orders o
JOIN printers p ON p.id = o.printer_id
JOIN toner_models t ON t.id = o.toner_id
"""


def _get(conn: sqlite3.Connection, order_id: int) -> sqlite3.Row:
    row = conn.execute(_SQL + " WHERE o.id = ?", (order_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Order not found")
    return row


@router.get("")
def list_orders(status: str = "ordered", conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    if status not in ("ordered", "received", "cancelled", "defect", "all"):
        raise HTTPException(400, "bad status")
    where, args = ("", ()) if status == "all" else (" WHERE o.status = ?", (status,))
    rows = conn.execute(_SQL + where + " ORDER BY o.created_ts DESC, o.id DESC LIMIT 500", args)
    return [dict(r) for r in rows]


@router.post("", status_code=201)
def create_orders(body: OrderIn, conn: sqlite3.Connection = Depends(db_dep),
                  username: str = Depends(current_username)) -> list[dict]:
    ids = []
    for it in body.items:
        if not conn.execute("SELECT 1 FROM printer_toners WHERE printer_id = ? AND toner_id = ?",
                            (it.printer_id, it.toner_id)).fetchone():
            raise HTTPException(404, "Printer/toner link not found")
        cur = conn.execute(
            "INSERT INTO orders (printer_id, toner_id, qty, note, created_by) VALUES (?,?,?,?,?)",
            (it.printer_id, it.toner_id, it.qty, body.note.strip(), username))
        ids.append(cur.lastrowid)
    return [dict(_get(conn, i)) for i in ids]


def _receive(conn: sqlite3.Connection, order_id: int, qty: int | None, location_id: int | None, username: str) -> None:
    """Mark one open order received: qty (default: as ordered) goes into the reserve at the location
    (default: the printer's default one) and is logged."""
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
    stockloc.log(conn, toner_id=order["toner_id"], printer_id=order["printer_id"], delta=qty, reason="received",
                 username=username, location_id=loc,
                 note=f"Garantijas aizvietotājs #{order_id}" if order["warranty"] else f"Pasūtījums #{order_id}")


class WarrantyIn(BaseModel):
    printer_id: int
    toner_id: int
    removed_pct: int | None = Field(default=None, ge=0, le=100)  # level when it was taken out, if known
    defect: str = Field(default="", max_length=200)
    note: str = Field(default="", max_length=500)


@router.post("/warranty", status_code=201)
def create_warranty(body: WarrantyIn, conn: sqlite3.Connection = Depends(db_dep),
                    username: str = Depends(current_username)) -> dict:
    """Put a defective cartridge on the "Defekti" list (status 'defect'). Nothing is expected yet, so it does
    not count as 'on order', and the reserve does not change (the cartridge came out of the printer, not the
    shelf). "Nodots garantijā" (send_warranty) moves it on to the open orders."""
    if not conn.execute("SELECT 1 FROM printer_toners WHERE printer_id = ? AND toner_id = ?",
                        (body.printer_id, body.toner_id)).fetchone():
        raise HTTPException(404, "Printer/toner link not found")
    cur = conn.execute(
        "INSERT INTO orders (printer_id, toner_id, qty, status, note, created_by, warranty, removed_pct, defect)"
        " VALUES (?,?,1,'defect',?,?,1,?,?)",
        (body.printer_id, body.toner_id, body.note.strip(), username, body.removed_pct, body.defect.strip()))
    return dict(_get(conn, cur.lastrowid))


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
    for it in body.items:
        _receive(conn, it.id, None, it.location_id, username)
    return [dict(_get(conn, i)) for i in ids]


@router.post("/{order_id}/receive")
def receive_order(order_id: int, body: ReceiveIn, conn: sqlite3.Connection = Depends(db_dep),
                  username: str = Depends(current_username)) -> dict:
    _receive(conn, order_id, body.qty, body.location_id, username)
    return dict(_get(conn, order_id))


@router.delete("/{order_id}")
def delete_order(order_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    """Remove an order record from the history. Stock is not touched: cartridges already received stay in the
    reserve (and their 'Saņemts' movement stays in the log); an open order just stops counting as ordered."""
    _get(conn, order_id)  # 404 if it doesn't exist
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
