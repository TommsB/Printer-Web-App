"""Stock per location: the one place that changes cartridge counts.

stock_locations holds how many cartridges of a printer+toner sit in each location;
printer_toners.qty is kept as their sum (so totals/norms elsewhere stay simple).
Every change goes through add() + sync_total() and is logged with log().
"""

import sqlite3

from fastapi import HTTPException


def location_or_404(conn: sqlite3.Connection, location_id: int, must_be_active: bool = True) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM locations WHERE id = ?", (location_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Vieta nav atrasta")
    if must_be_active and not row["active"]:
        raise HTTPException(400, f"Vieta \"{row['name']}\" ir arhivēta")
    return row


def qty_at(conn: sqlite3.Connection, printer_id: int, toner_id: int, location_id: int) -> int:
    row = conn.execute("SELECT qty FROM stock_locations WHERE printer_id = ? AND toner_id = ? AND location_id = ?",
                       (printer_id, toner_id, location_id)).fetchone()
    return row["qty"] if row else 0


def add(conn: sqlite3.Connection, printer_id: int, toner_id: int, location_id: int, delta: int) -> None:
    """Change the count at one location. Callers validate first; the CHECK constraint is the backstop."""
    if delta > 0:
        conn.execute(
            "INSERT INTO stock_locations (printer_id, toner_id, location_id, qty) VALUES (?,?,?,?)"
            " ON CONFLICT(printer_id, toner_id, location_id) DO UPDATE SET qty = qty + excluded.qty",
            (printer_id, toner_id, location_id, delta))
    else:
        # Plain UPDATE: an upsert would check the CHECK (qty >= 0) against the negative insert row first.
        conn.execute("UPDATE stock_locations SET qty = qty + ? WHERE printer_id = ? AND toner_id = ? AND location_id = ?",
                     (delta, printer_id, toner_id, location_id))
    conn.execute("DELETE FROM stock_locations WHERE printer_id = ? AND toner_id = ? AND location_id = ? AND qty = 0",
                 (printer_id, toner_id, location_id))


def sync_total(conn: sqlite3.Connection, printer_id: int, toner_id: int) -> None:
    conn.execute(
        "UPDATE printer_toners SET qty = (SELECT COALESCE(SUM(qty), 0) FROM stock_locations"
        " WHERE printer_id = ? AND toner_id = ?) WHERE printer_id = ? AND toner_id = ?",
        (printer_id, toner_id, printer_id, toner_id))


def log(conn: sqlite3.Connection, *, toner_id: int, printer_id: int, delta: int, reason: str, username: str,
        note: str = "", location_id: int | None = None, to_location_id: int | None = None) -> int:
    """Write the history entry; returns its id (what "Atsaukt" refers to right after the action)."""
    return conn.execute(
        "INSERT INTO stock_movements (toner_id, delta, reason, printer_id, username, note, location_id, to_location_id)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (toner_id, delta, reason, printer_id, username, note.strip(), location_id, to_location_id)).lastrowid


def breakdown(conn: sqlite3.Connection) -> dict[tuple[int, int], list[dict]]:
    """{(printer_id, toner_id): [{location_id, name, qty}, ...]} for all stock, in location order."""
    out: dict[tuple[int, int], list[dict]] = {}
    for r in conn.execute(
            "SELECT sl.printer_id, sl.toner_id, sl.location_id, l.name, l.short, sl.qty FROM stock_locations sl"
            " JOIN locations l ON l.id = sl.location_id WHERE sl.qty > 0 ORDER BY l.sort, l.name"):
        out.setdefault((r["printer_id"], r["toner_id"]), []).append(
            {"location_id": r["location_id"], "name": r["name"], "short": r["short"], "qty": r["qty"]})
    return out
