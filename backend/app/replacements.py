"""Detect toner and drum replacements from SNMP levels and let the user review them.

After each poll, every toner's and drum's level is compared with the previous successful reading of the
same printer. A big jump up (+30 points or more, ending at 50% or higher) means a new one was put in;
natural readings only go down, so small wobbles and coarse 10% steps don't trigger it. Other supplies
(waste box, fuser, belt…) are not tracked: they can be kept in the reserve and ordered, nothing more.

A detection is only *logged* (toner_events, status 'open'). The user reviews it in Žurnāls:
- confirm: removes 1 from the reserve (a normal 'taken' movement) and closes the event,
- dismiss: closes it without touching stock.
"""

import re
import sqlite3
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import empties, stockloc
from .auth import current_username
from .db import db_dep

MIN_RISE = 30
MIN_AFTER = 50

# Same rules as frontend/src/lib.ts (splitSupplies): which SNMP supplies are toners, and their colour.
_COLORS = (("black", "K"), ("cyan", "C"), ("magenta", "M"), ("yellow", "Y"))
_NOT_TONER = re.compile(r"drum|developer|imag|transfer|waste|fus|kit|unit|belt|roller", re.I)
_CODE_COLOR = re.compile(r"^[a-z]{1,3}-?\d{3,5}([cmyk])$", re.I)  # Kyocera: "CK-8511C"


def toner_color(description: str, mono: bool) -> str | None:
    """'K'/'C'/'M'/'Y' if this supply is a toner cartridge, else None."""
    if _NOT_TONER.search(description):
        return None
    d = description.lower()
    for word, col in _COLORS:
        if word in d:
            return col
    m = _CODE_COLOR.match(description.strip())
    if m:
        return m.group(1).upper()
    if mono and re.search(r"toner|cartridge", d):
        return "K"
    return None


_DRUM = re.compile(r"drum|photoconductor|imaging unit|image unit", re.I)
_NOT_DRUM = re.compile(r"developer|transfer|waste|fus|belt|roller", re.I)


def drum_color(description: str, mono: bool) -> str | None:
    """'K'/'C'/'M'/'Y' if this supply is a drum of that colour, '' for a drum the printer names without a
    colour (e.g. "Drum Unit" on a colour printer), None if it isn't a drum."""
    if not _DRUM.search(description) or _NOT_DRUM.search(description):
        return None
    d = description.lower()
    for word, col in _COLORS:
        if word in d:
            return col
    return "K" if mono else ""


def classify(description: str, mono: bool) -> tuple[str, str] | None:
    """(kind, colour) for the supplies that are tied to the reserve — ('toner', 'C'), ('drum', 'K'), ('drum', '') —
    or None for everything else (waste box, fuser, belt…: shown as levels only)."""
    col = toner_color(description, mono)
    if col is not None:
        return "toner", col
    col = drum_color(description, mono)
    if col is not None:
        return "drum", col
    return None


def pick(linked: list, kind: str, col: str, mono: bool):
    """Which of the printer's linked catalogue items (rows with id, kind, upper-case color) this supply is.

    Same kind and colour wins — the kind matters: a black drum must never be taken for the black toner.
    Then, for drums, a "CMY" drum: one code used for the cyan, magenta and yellow drum (not the black one).
    Without a colour match: a mono printer's only item of that kind; and for drums, the printer's one drum
    that has no colour set (a drum code shared by several colours, or the only drum)."""
    same = [t for t in linked if t["kind"] == kind]
    by_color = [t for t in same if col and t["color"] == col]
    if by_color:
        return by_color[0]
    if kind == "drum" and col in ("C", "M", "Y"):
        shared = [t for t in same if t["color"] == "CMY"]
        if shared:
            return shared[0]
    if mono and len(same) == 1:
        return same[0]
    if kind == "drum":
        uncoloured = [t for t in same if not t["color"]]
        if len(uncoloured) == 1:
            return uncoloured[0]
    return None


def detect(conn: sqlite3.Connection, printer_id: int, snapshot_id: int) -> int:
    """Compare a new snapshot with the previous reachable one; log jumps. Returns how many were found."""
    prev = conn.execute(
        "SELECT id FROM snmp_snapshots WHERE printer_id = ? AND reachable = 1 AND id < ?"
        " ORDER BY id DESC LIMIT 1", (printer_id, snapshot_id)).fetchone()
    if not prev:
        return 0
    printer = conn.execute("SELECT color_type FROM printers WHERE id = ?", (printer_id,)).fetchone()
    mono = bool(printer) and printer["color_type"] == "Melnbalts"
    old = {(r["idx"], r["description"]): r["pct"] for r in conn.execute(
        "SELECT idx, description, pct FROM snmp_supplies WHERE snapshot_id = ?", (prev["id"],))}
    linked = conn.execute(
        "SELECT t.id, t.kind, UPPER(t.color) AS color FROM printer_toners pt JOIN toner_models t ON t.id = pt.toner_id"
        " WHERE pt.printer_id = ?", (printer_id,)).fetchall()
    ts = conn.execute("SELECT ts FROM snmp_snapshots WHERE id = ?", (snapshot_id,)).fetchone()["ts"]

    found = 0
    for s in conn.execute("SELECT idx, description, pct FROM snmp_supplies WHERE snapshot_id = ?", (snapshot_id,)):
        before = old.get((s["idx"], s["description"]))
        after = s["pct"]
        if before is None or after is None or after - before < MIN_RISE or after < MIN_AFTER:
            continue
        what = classify(s["description"], mono)  # toners and drums; other supplies aren't tracked
        if what is None:
            continue
        kind, col = what
        item = pick(linked, kind, col, mono)
        conn.execute(
            "INSERT INTO toner_events (printer_id, toner_id, supply, color, from_pct, to_pct, ts, kind) VALUES (?,?,?,?,?,?,?,?)",
            (printer_id, item["id"] if item else None, s["description"], col, before, after, ts, kind))
        found += 1
    return found


# ---- review API (Žurnāls) --------------------------------------------------------------

router = APIRouter(prefix="/api/events", tags=["events"])

_SQL = """
SELECT e.id, e.printer_id, e.toner_id, e.supply, e.color, e.kind, e.from_pct, e.to_pct, e.ts, e.status,
       e.resolved_by, e.resolved_ts, p.location AS printer_location, p.model, p.empties_location_id, t.code AS toner_code,
       COALESCE(pt.qty, 0) AS qty
FROM toner_events e
JOIN printers p ON p.id = e.printer_id
LEFT JOIN toner_models t ON t.id = e.toner_id
LEFT JOIN printer_toners pt ON pt.printer_id = e.printer_id AND pt.toner_id = e.toner_id
"""


def _event(conn: sqlite3.Connection, event_id: int, locs: dict | None = None) -> dict:
    row = conn.execute(_SQL + " WHERE e.id = ?", (event_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Notikums nav atrasts")
    d = dict(row)
    locs = locs if locs is not None else stockloc.breakdown(conn)
    d["locations"] = locs.get((d["printer_id"], d["toner_id"]), []) if d["toner_id"] else []
    return d


@router.get("")
def list_events(status: str = "open", conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    if status not in ("open", "confirmed", "dismissed", "all"):
        raise HTTPException(400, "bad status")
    where, args = ("", ()) if status == "all" else (" WHERE e.status = ?", (status,))
    locs = stockloc.breakdown(conn)
    ids = [r["id"] for r in conn.execute(_SQL + where + " ORDER BY e.ts DESC, e.id DESC LIMIT 200", args)]
    return [_event(conn, i, locs) for i in ids]


class ConfirmIn(BaseModel):
    location_id: int | None = None  # required when the reserve is in more than one location
    empty_location_id: int | None = None  # where the old, empty cartridge is put ("Tukšie"); None = not counted


def _close(conn: sqlite3.Connection, event_id: int, status: str, username: str) -> None:
    conn.execute("UPDATE toner_events SET status = ?, resolved_by = ?, resolved_ts = ? WHERE id = ?",
                 (status, username, datetime.now().isoformat(timespec="seconds"), event_id))


@router.post("/{event_id}/confirm")
def confirm(event_id: int, body: ConfirmIn, conn: sqlite3.Connection = Depends(db_dep),
            username: str = Depends(current_username)) -> dict:
    """The replacement was real: take 1 cartridge out of the reserve (logged like 'Izlietots')."""
    e = _event(conn, event_id)
    if e["status"] != "open":
        raise HTTPException(409, "Jau apstrādāts")
    if not e["toner_id"]:
        what = "šīs krāsas drums" if e["kind"] == "drum" else "šīs krāsas toneris"
        raise HTTPException(400, f"Printerim nav piesaistīts {what} — izmantojiet 'Ignorēt'")
    loc = body.location_id
    if loc is None:
        if not e["locations"]:
            raise HTTPException(400, "Rezervē nav neviena — izmantojiet 'Ignorēt'")
        if len(e["locations"]) > 1:
            raise HTTPException(400, "Norādiet, no kuras vietas")
        loc = e["locations"][0]["location_id"]
    if stockloc.qty_at(conn, e["printer_id"], e["toner_id"], loc) < 1:
        raise HTTPException(400, "Šajā vietā nav neviena")
    stockloc.add(conn, e["printer_id"], e["toner_id"], loc, -1)
    stockloc.sync_total(conn, e["printer_id"], e["toner_id"])
    movement = stockloc.log(
        conn, toner_id=e["toner_id"], printer_id=e["printer_id"], delta=-1, reason="taken", username=username,
        note=f"Nomainīts (SNMP {e['from_pct']}% → {e['to_pct']}%, {e['ts'][:16].replace('T', ' ')})", location_id=loc)
    empties.from_used(conn, toner_id=e["toner_id"], location_id=body.empty_location_id, qty=1, username=username,
                      movement_id=movement, printer=e["printer_location"])
    _close(conn, event_id, "confirmed", username)
    return _event(conn, event_id)


@router.post("/{event_id}/dismiss")
def dismiss(event_id: int, conn: sqlite3.Connection = Depends(db_dep),
            username: str = Depends(current_username)) -> dict:
    e = _event(conn, event_id)
    if e["status"] != "open":
        raise HTTPException(409, "Jau apstrādāts")
    _close(conn, event_id, "dismissed", username)
    return _event(conn, event_id)
