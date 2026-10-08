import asyncio
from datetime import datetime, timedelta

from . import push, replacements
from .config import config
from .db import get_db
from .snmp import poll_many

_lock = asyncio.Lock()


def poll_all_sync(printer_id: int | None = None) -> int:
    with get_db() as conn:
        sql = "SELECT id, ip FROM printers WHERE active = 1 AND snmp_enabled = 1 AND ip IS NOT NULL"
        args: tuple = ()
        if printer_id is not None:
            sql += " AND id = ?"
            args = (printer_id,)
        targets = [(r["id"], r["ip"]) for r in conn.execute(sql, args)]

    results = poll_many(targets)
    ts = datetime.now().isoformat(timespec="seconds")

    with get_db() as conn:
        for pid, r in results.items():
            cur = conn.execute(
                "INSERT INTO snmp_snapshots (printer_id, ts, reachable, hostname, serial, status,"
                " uptime_hours, page_count, alerts, blocking, attention) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (pid, ts, int(r.reachable), r.hostname, r.serial, r.status,
                 r.uptime_hours, r.page_count, r.alerts, r.blocking, r.attention),
            )
            conn.executemany(
                "INSERT INTO snmp_supplies (snapshot_id, idx, description, level, max_capacity, pct)"
                " VALUES (?,?,?,?,?,?)",
                [(cur.lastrowid, s["idx"], s["description"], s["level"], s["max_capacity"], s["pct"])
                 for s in r.supplies],
            )
            if r.reachable and r.page_count is not None:  # the day's last counter, kept for the monthly figures
                conn.execute(
                    "INSERT INTO page_counts (printer_id, day, page_count) VALUES (?,?,?)"
                    " ON CONFLICT(printer_id, day) DO UPDATE SET page_count = excluded.page_count",
                    (pid, ts[:10], r.page_count))
            if r.reachable:  # each supply's last level of the day, kept for the analytics charts
                conn.executemany(
                    "INSERT INTO supply_days (printer_id, day, idx, description, pct) VALUES (?,?,?,?,?)"
                    " ON CONFLICT(printer_id, day, idx, description) DO UPDATE SET pct = excluded.pct",
                    [(pid, ts[:10], s["idx"], s["description"], s["pct"]) for s in r.supplies if s["pct"] is not None])
            if r.reachable:
                try:  # a detection problem must never stop the poll from being saved
                    replacements.detect(conn, pid, cur.lastrowid)
                except Exception as e:
                    print(f"[poller] replacement detection failed for printer {pid}: {e}")
        cutoff = (datetime.now() - timedelta(days=config["snapshot_keep_days"])).isoformat(timespec="seconds")
        conn.execute("DELETE FROM snmp_snapshots WHERE ts < ?", (cutoff,))
        messages = []
        try:  # notifications are an extra: a problem there must never stop the poll from being saved
            messages = push.after_poll(conn, list(results))
        except Exception as e:
            print(f"[poller] push check failed: {e}")
    push.dispatch(messages)  # after the commit; delivery runs in the background
    return len(results)


async def poll_all(printer_id: int | None = None) -> int:
    async with _lock:
        return await asyncio.to_thread(poll_all_sync, printer_id)


async def poll_loop() -> None:
    interval = max(1, int(config["poll_interval_minutes"])) * 60
    while True:
        try:
            await poll_all()
        except Exception as e:  # keep the loop alive on any failure
            print(f"[poller] error: {e}")
        await asyncio.sleep(interval)
