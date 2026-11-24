"""Cost forecast ("Izmaksas" in Analītika): what each printer costs to run and per page, and what was really spent.

Prices are per component code (toner_models.price, € per cartridge, entered in Pārvaldība → Komponenti).

Running cost — from the levels, not from purchases. Every toner and drum level is kept per day (supply_days).
Over the chosen period, each supply's daily drops are added up (a big rise is a new cartridge and adds nothing),
so "used 140%" of a 120 € cartridge cost 168 €. That, spread over the days the readings cover, gives a cost per
day, per month (× 30.44) and per year (× 365); divided by the pages printed in the same days, a cost per page.
It follows the printer's real pace, every colour and drum on its own.
Printers without level readings (not on the network, SNMP off, or under a week of readings) fall back to the
cartridges actually taken from their reserve in the last 180 days.

Actual — what was really spent: received orders (warranty replacements excluded), on their delivery day, at the
price kept with each order (orders.unit_price: the component's price when it was ordered, correctable later in
Vēsture → Pasūtījumi). Per month for a year, this year so far, and the last RECENT_DAYS days (set against the
forecast, to see whether more is bought than used).
"""

import sqlite3
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException

from . import forecast, pagecount
from .db import db_dep
from .replacements import classify, pick

router = APIRouter(prefix="/api", tags=["costs"])

PERIODS = (30, 90)
MONTH = 30.44
MIN_SPAN = 7  # days of level readings needed before the pace means anything
NEW_CARTRIDGE = 10  # a rise this big between two days = a new cartridge (as in forecast.py)
FALLBACK_DAYS = 180  # printers without levels: cartridges taken in this many days
FALLBACK_MIN = 30  # …spread over at least this many days, even for a printer tracked for a shorter time
ACTUAL_MONTHS = 12  # actual spending: this many calendar months
RECENT_DAYS = 90  # …and the last this many days, against the forecast for them


def _linked(conn: sqlite3.Connection, printer_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT t.id, t.code, t.kind, UPPER(t.color) AS color, t.price"
        " FROM printer_toners pt JOIN toner_models t ON t.id = pt.toner_id WHERE pt.printer_id = ?", (printer_id,)).fetchall()


def _pages(conn: sqlite3.Connection, printer_id: int, first: str, last: str) -> int:
    """Pages printed between two days: the counter's growth (a one-day glitch or a reset handled in pagecount.py)."""
    return pagecount.total([r["page_count"] for r in conn.execute(
        "SELECT page_count FROM page_counts WHERE printer_id = ? AND day >= ? AND day <= ? ORDER BY day", (printer_id, first, last))])


def _days_between(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _from_levels(conn: sqlite3.Connection, p: sqlite3.Row, linked: list[sqlite3.Row], days: int) -> dict | None:
    """Cost from the daily levels, or None when there aren't enough of them.

    One chain per cartridge slot (SNMP supply index), not per description: when a slot starts reporting another
    name (a 410A swapped for a 410X, a compatible cartridge with its own code) that is a new cartridge in the same
    slot — the drop across the change counts nothing, and the slot is shown once, under its current name.

    A slot is still in the printer when the printer's latest reading lists it — also when it gives no level (an HP
    reports -2, "unknown", once a cartridge is very low): its daily levels stop, but its history still gives its pace
    and cost, and it shows its last known level (level_known False, since last_day). Only a slot the latest reading no
    longer lists is gone: it still counts what it used, but has no pace going forward."""
    mono = p["color_type"] == "Melnbalts"
    since = (date.today() - timedelta(days=days)).isoformat()
    slots: dict[str, list[tuple[str, str, int]]] = {}
    for r in conn.execute("SELECT day, idx, description, pct FROM supply_days WHERE printer_id = ? AND day >= ? ORDER BY day",
                          (p["id"], since)):
        slots.setdefault(r["idx"], []).append((r["day"], r["description"], r["pct"]))
    all_days = sorted({d for pts in slots.values() for d, _, _ in pts})
    if len(all_days) < 2:
        return None
    first, last = all_days[0], all_days[-1]
    span = _days_between(first, last)
    if span < MIN_SPAN:
        return None
    left = forecast.days_left(conn, p["id"])  # {supply idx: days}, the run-out shown in Statuss
    # The slots the printer reports right now (with or without a level): what is still in it.
    latest = conn.execute("SELECT MAX(id) FROM snmp_snapshots WHERE printer_id = ? AND reachable = 1", (p["id"],)).fetchone()[0]
    reported = {r["idx"] for r in conn.execute("SELECT idx FROM snmp_supplies WHERE snapshot_id = ?", (latest,))} if latest else None

    supplies, missing = [], set()
    for idx, points in slots.items():
        desc = points[-1][1]  # what the slot is now
        what = classify(desc, mono)
        if what is None:
            continue  # waste box, fuser…: no reserve, no price
        item = pick(linked, *what, mono)
        if item is None:
            continue
        used = 0
        for (_, da, a), (_, db, b) in zip(points, points[1:]):
            if da == db and b < a:  # a rise, or another name in the slot, is a new cartridge: nothing used
                used += a - b
        own = _days_between(points[0][0], points[-1][0])  # this slot's own readings, not the printer's
        per_day = used / own if own >= MIN_SPAN else 0.0  # % of a cartridge per day; too few days = no pace yet
        level_known = points[-1][0] == last  # it had a level on the latest day
        # Still in the printer: listed in the latest reading (with or without a level); without a reading, as before.
        current = idx in reported if reported is not None else level_known
        now = points[-1][2] if current else None  # the last level known (older when level_known is False)
        runs_out = left.get(idx) if current else None
        if current and level_known and runs_out is None and per_day > 0:
            runs_out = round(now / per_day)
        if item["price"] is None:
            missing.add(item["code"])
        price = item["price"]
        # What the view shows per component, all from the same pace: a cartridge lasts 100% ÷ (% a day) days, which is
        # (365 ÷ that) replacements a year, and costs price × (% a day ÷ 100) × 30.44 a month. A slot no longer
        # reported (current False) used what it used, but has no pace going forward.
        pace = per_day if current else 0.0
        supplies.append({
            "toner_id": item["id"], "code": item["code"], "kind": item["kind"], "color": what[1], "price": price,
            "used_pct": used, "pct_per_day": per_day, "level": now, "runs_out_days": runs_out, "current": current,
            "own_days": own, "level_known": current and level_known, "last_day": points[-1][0],
            "life_days": round(100 / pace) if pace > 0 else None,
            "per_year": round(365 * pace / 100, 1) if pace > 0 else None,
            "per_month": None if price is None else round(price * pace / 100 * MONTH, 2),
            "cost": None if price is None else round(used / 100 * price, 2),
        })
    if not supplies:
        return None
    cost = sum(s["cost"] or 0 for s in supplies)
    pages = _pages(conn, p["id"], first, last)
    # The printer's running cost a day: its components' together (so the per-component table adds up to the total).
    per_day_cost = sum(s["per_month"] for s in supplies if s["per_month"] is not None) / MONTH
    pages_per_day = pages / span
    return {"method": "levels", "priced": any(s["cost"] is not None for s in supplies), "span_days": span, "pages": pages, "cost": round(cost, 2),
            "per_day": per_day_cost, "pages_per_day": pages_per_day,
            "cost_per_page": per_day_cost / pages_per_day if pages_per_day > 0 and per_day_cost > 0 else None,
            "supplies": supplies, "missing": sorted(missing)}


def _tracked_since(conn: sqlite3.Connection, printer_id: int) -> date | None:
    """The first day this printer appears in the app's records (stock moves, daily levels, page counter)."""
    row = conn.execute(
        "SELECT MIN(d) FROM (SELECT MIN(substr(ts, 1, 10)) AS d FROM stock_movements WHERE printer_id = ?"
        " UNION ALL SELECT MIN(day) FROM supply_days WHERE printer_id = ? UNION ALL SELECT MIN(day) FROM page_counts WHERE printer_id = ?)",
        (printer_id, printer_id, printer_id)).fetchone()
    return date.fromisoformat(row[0]) if row and row[0] else None


def _from_taken(conn: sqlite3.Connection, p: sqlite3.Row) -> dict | None:
    """Fallback: the cartridges taken from this printer's reserve in the last FALLBACK_DAYS days, spread over the
    days the printer has really been tracked (at least FALLBACK_MIN, so one early cartridge doesn't read as a
    huge monthly cost), not always over the full FALLBACK_DAYS."""
    since = (datetime.now() - timedelta(days=FALLBACK_DAYS)).isoformat(timespec="seconds")
    rows = conn.execute(
        "SELECT t.code, t.price, -SUM(m.delta) AS qty FROM stock_movements m JOIN toner_models t ON t.id = m.toner_id"
        " WHERE m.printer_id = ? AND m.reason = 'taken' AND m.ts >= ? GROUP BY t.id HAVING qty > 0", (p["id"], since)).fetchall()
    if not rows:
        return None
    start = _tracked_since(conn, p["id"])
    tracked = (date.today() - start).days if start else FALLBACK_DAYS
    span = min(FALLBACK_DAYS, max(FALLBACK_MIN, tracked))
    cost = sum((r["price"] or 0) * r["qty"] for r in rows)
    return {"method": "taken", "priced": any(r["price"] is not None for r in rows), "span_days": span, "pages": None, "cost": round(cost, 2),
            "per_day": cost / span, "pages_per_day": None, "cost_per_page": None,
            "supplies": [], "missing": sorted({r["code"] for r in rows if r["price"] is None})}


def _months_back(n: int) -> list[str]:
    """The last n calendar months, oldest first, this month last ("2026-11")."""
    today = date.today()
    out, y, m = [], today.year, today.month
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out[::-1]


def _actual(conn: sqlite3.Connection) -> dict:
    """What was really spent: received orders (not warranty replacements, which cost nothing), counted on the day
    they were delivered, at the price kept with the order (orders.unit_price — the component's price when ordered,
    correctable in Vēsture). Orders from before prices were kept use today's component price and count as
    `estimated`; orders with no price at all count 0 € and as `unpriced`.

    months: the last ACTUAL_MONTHS calendar months, oldest first — total, cartridges, and per company / printer.
    year: this calendar year so far. recent: the last RECENT_DAYS days (set against the forecast for the same days).
    """
    today = date.today()
    months = _months_back(ACTUAL_MONTHS)
    recent_from = (today - timedelta(days=RECENT_DAYS)).isoformat()
    year_from = f"{today.year:04d}-01-01"
    since = min(months[0] + "-01", recent_from, year_from)

    def bucket() -> dict:
        return {"cost": 0.0, "qty": 0, "toners": 0, "drums": 0, "estimated": 0, "unpriced": 0, "by_company": {}, "by_printer": {}}

    by_month = {k: {"month": k, **bucket()} for k in months}
    year, recent = bucket(), bucket()

    def add(b: dict, company: str, printer_id: int, cost: float, qty: int, estimated: bool, unpriced: bool, kind: str) -> None:
        toners, drums = (qty if kind == "toner" else 0), (qty if kind == "drum" else 0)  # 'other' (waste box…) only in qty
        b["cost"] = round(b["cost"] + cost, 2)
        b["qty"] += qty
        b["toners"] += toners
        b["drums"] += drums
        b["estimated"] += qty if estimated else 0
        b["unpriced"] += qty if unpriced else 0
        b["by_company"][company] = round(b["by_company"].get(company, 0) + cost, 2)
        # [cost, cartridges, of them priced at today's price, of them without any price, toners, drums] — the
        # per-printer view shows the same as the overview.
        was = b["by_printer"].get(printer_id, [0, 0, 0, 0, 0, 0])
        b["by_printer"][printer_id] = [round(was[0] + cost, 2), was[1] + qty, was[2] + (qty if estimated else 0),
                                       was[3] + (qty if unpriced else 0), was[4] + toners, was[5] + drums]

    for r in conn.execute(
            "SELECT o.printer_id, p.company, substr(o.resolved_ts, 1, 10) AS day, COALESCE(o.received_qty, o.qty) AS qty,"
            " o.unit_price, t.price AS now_price, t.kind FROM orders o JOIN toner_models t ON t.id = o.toner_id"
            " JOIN printers p ON p.id = o.printer_id"
            " WHERE o.status = 'received' AND o.warranty = 0 AND o.resolved_ts >= ?", (since,)):
        if not r["day"] or (r["qty"] or 0) <= 0:
            continue
        price = r["unit_price"] if r["unit_price"] is not None else r["now_price"]
        estimated = r["unit_price"] is None and r["now_price"] is not None
        unpriced = price is None
        cost = (price or 0) * r["qty"]
        args = (r["company"] or "", r["printer_id"], cost, r["qty"], estimated, unpriced, r["kind"])
        if r["day"][:7] in by_month:
            add(by_month[r["day"][:7]], *args)
        if r["day"] >= year_from:
            add(year, *args)
        if r["day"] >= recent_from:
            add(recent, *args)
    return {"months": list(by_month.values()), "year": year, "recent": recent, "recent_days": RECENT_DAYS}


def summary(conn: sqlite3.Connection, days: int) -> dict:
    printers = []
    for p in conn.execute("SELECT id, location, company, model, ip, snmp_enabled, color_type FROM printers WHERE active = 1"
                          " ORDER BY company, location"):
        linked = _linked(conn, p["id"])
        found = (_from_levels(conn, p, linked, days) if p["ip"] and p["snmp_enabled"] else None) or _from_taken(conn, p)
        row = {"id": p["id"], "location": p["location"], "company": p["company"], "model": p["model"],
               "method": None, "per_month": None, "per_year": None, "cost_per_page": None, "pages_per_month": None,
               "span_days": None, "supplies": [], "missing": []}
        if found:
            row.update(method=found["method"], span_days=found["span_days"], supplies=found["supplies"], missing=found["missing"],
                       pages_per_month=None if found["pages_per_day"] is None else round(found["pages_per_day"] * MONTH))
            if found["priced"]:  # with no price at all it would read 0 €: leave the sums empty instead
                row.update(per_month=round(found["per_day"] * MONTH, 2), per_year=round(found["per_day"] * 365, 2),
                           cost_per_page=None if found["cost_per_page"] is None else round(found["cost_per_page"], 4))
        # Linked codes without a price (even ones not used in this period): what to fill in for a complete picture.
        row["unpriced"] = sorted({t["code"] for t in linked if t["price"] is None and t["kind"] in ("toner", "drum")})
        printers.append(row)

    priced = [r for r in printers if r["per_month"] is not None]
    per_month = sum(r["per_month"] for r in priced)
    level_rows = [r for r in priced if r["method"] == "levels" and r["pages_per_month"]]
    pages = sum(r["pages_per_month"] for r in level_rows)
    by_company: dict[str, float] = {}
    for r in priced:
        by_company[r["company"] or ""] = round(by_company.get(r["company"] or "", 0) + r["per_month"], 2)
    return {
        "days": days,
        "per_month": round(per_month, 2), "per_year": round(per_month / MONTH * 365, 2),
        "cost_per_page": round(sum(r["per_month"] for r in level_rows) / pages, 4) if pages else None,
        "by_company": by_company,
        "unpriced": sorted({c for r in printers for c in r["unpriced"]}),
        "actual": _actual(conn),
        "printers": printers,
    }


@router.get("/costs")
def costs(days: int = 30, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    """The cost forecast and the actual spending for every active printer (see the module docstring). `days`: the
    period the pace is taken from."""
    if days not in PERIODS:
        raise HTTPException(422, "Periods var būt 30 vai 90 dienas")
    return summary(conn, days)
