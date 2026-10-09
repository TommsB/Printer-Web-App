import sqlite3
from datetime import datetime, timedelta
from ipaddress import IPv4Address

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import forecast, snmp, stockloc
from .auth import current_username
from .db import db_dep
from .poller import poll_all

router = APIRouter(prefix="/api/printers", tags=["printers"])


class PrinterIn(BaseModel):
    company: str = ""
    location: str
    model: str = ""
    brand: str = ""
    ip: str | None = None  # empty = not on the network: only the toner reserve is tracked
    color_type: str = "Krāsains"
    snmp_enabled: bool = True
    active: bool = True
    notes: str = ""
    default_location_id: int | None = None  # where received cartridges go by default
    empties_location_id: int | None = None  # where this printer's empty cartridges go by default (Tukšie)
    toner_ids: list[int] = []
    norms: dict[int, int] = {}  # toner_id -> optimal stock ("norma"); only set via the Pārvaldība form


def _pages_today(conn: sqlite3.Connection, printer_id: int, current: int | None) -> dict:
    """Pages printed today = current counter minus the last reading before local midnight.

    If there is no reading from before midnight yet (e.g. the app started today), the first
    reading of today is used and `pages_since` says from when, so the UI can label it honestly.
    """
    out = {"pages_today": None, "pages_since": None}
    if current is None:
        return out
    base_sql = ("SELECT ts, page_count FROM snmp_snapshots WHERE printer_id = ? AND reachable = 1"
                " AND page_count IS NOT NULL AND ts {op} date('now','localtime') ORDER BY ts {order} LIMIT 1")
    row = conn.execute(base_sql.format(op="<", order="DESC"), (printer_id,)).fetchone()
    if row is None:
        row = conn.execute(base_sql.format(op=">=", order="ASC"), (printer_id,)).fetchone()
        if row is None:
            return out
        out["pages_since"] = row["ts"]
    if current >= row["page_count"]:  # a lower counter means the printer was reset/replaced
        out["pages_today"] = current - row["page_count"]
    return out


def _printer_dict(conn: sqlite3.Connection, row: sqlite3.Row, with_supplies: bool,
                  locs: dict | None = None) -> dict:
    d = dict(row)
    d["snmp_enabled"] = bool(d["snmp_enabled"])
    d["active"] = bool(d["active"])
    # No IP = not polled; readings left from when it still had an address would only mislead.
    snap = conn.execute(
        "SELECT * FROM snmp_snapshots WHERE printer_id = ? ORDER BY ts DESC, id DESC LIMIT 1",
        (d["id"],),
    ).fetchone() if d["ip"] else None
    d["snapshot"] = None
    if snap:
        s = dict(snap)
        s["reachable"] = bool(s["reachable"])
        if with_supplies:
            s["supplies"] = [dict(x) for x in conn.execute(
                "SELECT idx, description, level, max_capacity, pct FROM snmp_supplies"
                " WHERE snapshot_id = ? ORDER BY CAST(idx AS INTEGER)", (snap["id"],))]
            # Run-out forecast per supply (days), None when it can't be estimated — see forecast.py.
            left = forecast.days_left(conn, d["id"]) if s["reachable"] else {}
            for x in s["supplies"]:
                x["days_left"] = left.get(x["idx"])
        s.update(_pages_today(conn, d["id"], s["page_count"]))
        d["snapshot"] = s
    d["toners"] = [dict(x) for x in conn.execute(
        "SELECT t.id, t.code, t.color, t.kind, pt.qty, pt.optimal_qty, pt.qty < pt.optimal_qty AS low,"
        " (SELECT COALESCE(SUM(o.qty), 0) FROM orders o WHERE o.status = 'ordered'"
        "  AND o.printer_id = pt.printer_id AND o.toner_id = pt.toner_id) AS ordered,"
        " (SELECT COALESCE(SUM(o.qty), 0) FROM orders o WHERE o.status = 'ordered' AND o.extra = 1"
        "  AND o.printer_id = pt.printer_id AND o.toner_id = pt.toner_id) AS ordered_extra"
        " FROM printer_toners pt JOIN toner_models t ON t.id = pt.toner_id"
        " WHERE pt.printer_id = ? ORDER BY t.code", (d["id"],))]
    if locs is None:
        locs = stockloc.breakdown(conn)
    for t in d["toners"]:
        t["low"] = bool(t["low"])
        t["locations"] = locs.get((d["id"], t["id"]), [])
    return d


def _set_toners(conn: sqlite3.Connection, printer_id: int, toner_ids: list[int],
                norms: dict[int, int] | None = None) -> None:
    # Keep qty/optimal for toners that stay linked; only add/remove the difference.
    keep = set(toner_ids)
    for (tid,) in conn.execute("SELECT toner_id FROM printer_toners WHERE printer_id = ?", (printer_id,)).fetchall():
        if tid not in keep:
            conn.execute("DELETE FROM printer_toners WHERE printer_id = ? AND toner_id = ?", (printer_id, tid))
            conn.execute("DELETE FROM stock_locations WHERE printer_id = ? AND toner_id = ?", (printer_id, tid))
    conn.executemany("INSERT OR IGNORE INTO printer_toners (printer_id, toner_id) VALUES (?,?)",
                     [(printer_id, t) for t in keep])
    for tid, norm in (norms or {}).items():
        if tid in keep:
            conn.execute("UPDATE printer_toners SET optimal_qty = ? WHERE printer_id = ? AND toner_id = ?",
                         (max(0, norm), printer_id, tid))


@router.get("")
def list_printers(conn: sqlite3.Connection = Depends(db_dep),
                  username: str = Depends(current_username)) -> list[dict]:
    # In the user's own order ("Pielāgota secība"); printers they haven't placed yet follow by company/location.
    rows = conn.execute(
        "SELECT p.* FROM printers p LEFT JOIN user_printer_order o ON o.printer_id = p.id AND o.username = ?"
        " ORDER BY o.position IS NULL, o.position, p.company, p.location", (username,)).fetchall()
    locs = stockloc.breakdown(conn)
    return [_printer_dict(conn, r, with_supplies=True, locs=locs) for r in rows]  # list view draws per-toner bars


class OrderIn(BaseModel):
    ids: list[int]  # printer ids, first = top of the list


@router.put("/order")
def set_order(body: OrderIn, conn: sqlite3.Connection = Depends(db_dep),
              username: str = Depends(current_username)) -> dict:
    """Save the user's custom printer order (rearranged by dragging in Statuss). Unknown ids are ignored."""
    known = {r[0] for r in conn.execute("SELECT id FROM printers")}
    ids = list(dict.fromkeys(i for i in body.ids if i in known))  # keep first occurrence, drop unknown
    conn.execute("DELETE FROM user_printer_order WHERE username = ?", (username,))
    conn.executemany("INSERT INTO user_printer_order (username, printer_id, position) VALUES (?,?,?)",
                     [(username, pid, pos) for pos, pid in enumerate(ids)])
    return {"ids": ids}


@router.post("/refresh")
async def refresh() -> dict:
    return {"polled": await poll_all()}


class SnmpTestIn(BaseModel):
    ip: IPv4Address  # validated: only a plain IPv4 address ever reaches the snmp command line


@router.post("/test-snmp")
def test_snmp(body: SnmpTestIn) -> dict:
    """'Pārbaudīt savienojumu' in the printer editor (sync: runs in the thread pool, can take a few seconds)."""
    return snmp.test_printer(str(body.ip))


@router.get("/{printer_id}")
def get_printer(printer_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    row = conn.execute("SELECT * FROM printers WHERE id = ?", (printer_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Printer not found")
    return _printer_dict(conn, row, with_supplies=True)


USAGE_MONTHS = 12


@router.get("/{printer_id}/usage")
def usage(printer_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    """Per month, newest first: pages printed and cartridges used (the printer's info view).

    Pages come from the daily page counter (page_counts): each day's growth is added to its month. A counter
    that went down (printer reset or replaced) adds nothing. In the month the readings begin, counting starts
    at the first reading — `since` says from which day, so the UI can show that the month is incomplete.
    Cartridges are the "Izlietots" entries of the history for this printer.
    """
    months: dict[str, dict] = {}

    def month(key: str) -> dict:
        return months.setdefault(key, {"month": key, "pages": None, "since": None, "toners": [], "defects": []})

    prev = None
    for r in conn.execute("SELECT day, page_count FROM page_counts WHERE printer_id = ? ORDER BY day", (printer_id,)):
        m = month(r["day"][:7])
        if m["pages"] is None:
            m["pages"] = 0
        if prev is None:
            m["since"] = r["day"]
        elif r["page_count"] >= prev:
            m["pages"] += r["page_count"] - prev
        prev = r["page_count"]
    for r in conn.execute(
            "SELECT substr(m.ts, 1, 7) AS month, t.code, t.color, t.kind, -SUM(m.delta) AS qty FROM stock_movements m"
            " JOIN toner_models t ON t.id = m.toner_id WHERE m.printer_id = ? AND m.reason = 'taken'"
            " GROUP BY month, t.id HAVING qty > 0 ORDER BY t.code", (printer_id,)):
        month(r["month"])["toners"].append({"code": r["code"], "color": r["color"], "kind": r["kind"], "qty": r["qty"]})
    for r in conn.execute(  # defective cartridges, in the month they were noted
            "SELECT substr(o.created_ts, 1, 7) AS month, t.code, t.color, t.kind, COUNT(*) AS qty FROM orders o"
            " JOIN toner_models t ON t.id = o.toner_id WHERE o.printer_id = ? AND o.warranty = 1"
            " GROUP BY month, t.id ORDER BY t.code", (printer_id,)):
        month(r["month"])["defects"].append({"code": r["code"], "color": r["color"], "kind": r["kind"], "qty": r["qty"]})
    return sorted(months.values(), key=lambda m: m["month"], reverse=True)[:USAGE_MONTHS]


ANALYTICS_PERIODS = (7, 30, 90)  # the periods the "Analītika" sheet offers


@router.get("/{printer_id}/analytics")
def analytics(printer_id: int, days: int = 30, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    """The last `days` days (7, 30 or 90), day by day, for the "Analītika" charts.

    `pages`: printed that day, from the daily page counter (a day with no reading counts 0 and its pages land
    on the next day that has one; None before the very first reading; a counter that went down adds nothing).
    `supplies`: every supply the printer reported, with its level (pct) at the end of each day, None where
    there was no reading (from the daily supply_days, kept for good). What is a toner, and how much of it
    went, is worked out in the UI, which already knows how to tell the supplies apart.
    `prev`: the same three for the period just before (as many days again), for the "pret iepr." comparison.
    """
    if days not in ANALYTICS_PERIODS:
        raise HTTPException(422, "Periods var būt 7, 30 vai 90 dienas")
    today = datetime.now().date()
    span = [(today - timedelta(days=i)).isoformat() for i in range(2 * days - 1, -1, -1)]  # previous period + this one

    counts = {r["day"]: r["page_count"] for r in conn.execute(
        "SELECT day, page_count FROM page_counts WHERE printer_id = ? AND day >= ?", (printer_id, span[0]))}
    before = conn.execute("SELECT page_count FROM page_counts WHERE printer_id = ? AND day < ? ORDER BY day DESC LIMIT 1",
                          (printer_id, span[0])).fetchone()
    last = before["page_count"] if before else None
    pages: list[int | None] = []
    for d in span:
        cur = counts.get(d)
        if cur is None:
            pages.append(None if last is None else 0)
            continue
        pages.append(None if last is None else max(0, cur - last))
        last = cur

    series: dict[tuple[str, str], dict[str, int]] = {}
    for r in conn.execute("SELECT day, idx, description, pct FROM supply_days WHERE printer_id = ? AND day >= ? ORDER BY day",
                          (printer_id, span[0])):
        series.setdefault((r["idx"], r["description"]), {})[r["day"]] = r["pct"]

    def part(start: int, end: int) -> dict:
        return {"days": span[start:end], "pages": pages[start:end],
                "supplies": [{"idx": idx, "description": desc, "pct": [by_day.get(d) for d in span[start:end]]}
                             for (idx, desc), by_day in series.items()]}

    return {**part(days, 2 * days), "prev": part(0, days)}


@router.post("/{printer_id}/refresh")
async def refresh_one(printer_id: int) -> dict:
    return {"polled": await poll_all(printer_id)}


def _ip(body: PrinterIn) -> str | None:
    """The address to store: a valid IPv4, or None for a printer that isn't on the network."""
    ip = (body.ip or "").strip()
    if not ip:
        return None
    try:
        return str(IPv4Address(ip))
    except ValueError:
        raise HTTPException(422, "IP adresei jābūt formā 192.168.0.10")


@router.post("", status_code=201)
def create_printer(body: PrinterIn, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    ip = _ip(body)
    try:
        cur = conn.execute(
            "INSERT INTO printers (company, location, model, brand, ip, color_type, snmp_enabled, active, notes,"
            " default_location_id, empties_location_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (body.company, body.location, body.model, body.brand, ip, body.color_type,
             int(body.snmp_enabled), int(body.active), body.notes, body.default_location_id, body.empties_location_id))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Printeris ar šādu IP jau eksistē")
    _set_toners(conn, cur.lastrowid, body.toner_ids, body.norms)
    return get_printer(cur.lastrowid, conn)


@router.put("/{printer_id}")
def update_printer(printer_id: int, body: PrinterIn, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    ip = _ip(body)
    try:
        cur = conn.execute(
            "UPDATE printers SET company=?, location=?, model=?, brand=?, ip=?, color_type=?,"
            " snmp_enabled=?, active=?, notes=?, default_location_id=?, empties_location_id=? WHERE id=?",
            (body.company, body.location, body.model, body.brand, ip, body.color_type,
             int(body.snmp_enabled), int(body.active), body.notes, body.default_location_id, body.empties_location_id, printer_id))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Printeris ar šādu IP jau eksistē")
    if cur.rowcount == 0:
        raise HTTPException(404, "Printer not found")
    if ip is None:  # taken off the network: forget what was announced, so a later return starts clean
        keys = (f"offline:{printer_id}", f"blocked:{printer_id}", f"lowtoner:{printer_id}:%", f"lowdrum:{printer_id}:%")
        conn.execute("DELETE FROM push_state WHERE key IN (?, ?) OR key LIKE ? OR key LIKE ?", keys)
        conn.execute("DELETE FROM push_pending WHERE key IN (?, ?) OR key LIKE ? OR key LIKE ?", keys)  # and what waited for someone's hours
    _set_toners(conn, printer_id, body.toner_ids, body.norms)
    return get_printer(printer_id, conn)


@router.delete("/{printer_id}")
def delete_printer(printer_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    cur = conn.execute("DELETE FROM printers WHERE id = ?", (printer_id,))
    if cur.rowcount == 0:
        raise HTTPException(404, "Printer not found")
    return {"ok": True}
