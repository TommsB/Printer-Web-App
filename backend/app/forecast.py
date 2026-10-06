"""Toner run-out forecast: roughly how many days until a cartridge is empty, from its own SNMP history.

For every supply the last reading of each day (up to 30 days back) is taken, cut down to the cartridge that
is in the printer now (a jump up = a new cartridge, older readings don't count), and a straight line is fitted
through it. Days left = today's level divided by the daily drop.

It is an estimate: it assumes the printer keeps being used like in the last days/weeks. Nothing is returned
when there isn't enough to go on — under 3 days of readings for the current cartridge, or a level that
doesn't go down (many printers report in 10% steps, so that can take a while).
"""

import sqlite3
from datetime import datetime, timedelta

WINDOW_DAYS = 30
MIN_SPAN_DAYS = 3.0
NEW_CARTRIDGE_RISE = 10  # a rise this big between two days = the cartridge was replaced
MAX_DAYS = 365  # beyond this the number means nothing

# printer_id -> (latest reachable snapshot id, result). Recomputed only when a new reading arrives.
_cache: dict[int, tuple[int, dict[str, int]]] = {}


def _slope(points: list[tuple[float, int]]) -> float:
    """Least-squares slope (percent per day)."""
    n = len(points)
    mx = sum(x for x, _ in points) / n
    my = sum(y for _, y in points) / n
    den = sum((x - mx) ** 2 for x, _ in points)
    return sum((x - mx) * (y - my) for x, y in points) / den if den else 0.0


def _estimate(points: list[tuple[float, int]]) -> int | None:
    """points: (day number, pct), oldest first."""
    start = 0
    for i in range(1, len(points)):
        if points[i][1] - points[i - 1][1] >= NEW_CARTRIDGE_RISE:
            start = i
    current = points[start:]
    if len(current) < 3 or current[-1][0] - current[0][0] < MIN_SPAN_DAYS:
        return None
    now = current[-1][1]
    if now <= 0:
        return 0
    per_day = -_slope(current)
    if per_day <= 0:
        return None
    days = round(now / per_day)
    return days if days <= MAX_DAYS else None


def days_left(conn: sqlite3.Connection, printer_id: int) -> dict[str, int]:
    """{supply idx: days until empty} for the supplies in the printer's latest reading that can be estimated."""
    latest = conn.execute("SELECT MAX(id) FROM snmp_snapshots WHERE printer_id = ? AND reachable = 1",
                          (printer_id,)).fetchone()[0]
    if latest is None:
        return {}
    hit = _cache.get(printer_id)
    if hit and hit[0] == latest:
        return hit[1]

    since = (datetime.now() - timedelta(days=WINDOW_DAYS)).isoformat(timespec="seconds")
    rows = conn.execute(
        "SELECT s.id, s.ts, u.idx, u.description, u.pct FROM snmp_snapshots s"
        " JOIN snmp_supplies u ON u.snapshot_id = s.id"
        " WHERE u.pct IS NOT NULL AND s.id IN (SELECT MAX(id) FROM snmp_snapshots"
        "  WHERE printer_id = ? AND reachable = 1 AND ts >= ? GROUP BY substr(ts, 1, 10))"
        " ORDER BY s.id", (printer_id, since)).fetchall()
    series: dict[tuple[str, str], list[tuple[float, int]]] = {}
    in_latest: dict[tuple[str, str], str] = {}
    for r in rows:
        key = (r["idx"], r["description"])  # same key as replacement detection: a renamed slot starts over
        day = datetime.fromisoformat(r["ts"]).timestamp() / 86400
        series.setdefault(key, []).append((day, r["pct"]))
        if r["id"] == latest:
            in_latest[key] = r["idx"]

    out: dict[str, int] = {}
    for key, idx in in_latest.items():
        days = _estimate(series[key])
        if days is not None:
            out[idx] = days
    _cache[printer_id] = (latest, out)
    return out
