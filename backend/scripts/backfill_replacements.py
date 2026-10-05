"""One-off: run replacement detection over already-saved readings (default: today) so swaps that
happened before the feature existed show up in Žurnāls → Jāpārbauda. Only creates review items;
stock is never changed. Skips snapshots that already produced an event.

Usage (in the container):  python scripts/backfill_replacements.py [YYYY-MM-DD]
"""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import replacements  # noqa: E402
from app.db import get_db, init_db  # noqa: E402

since = sys.argv[1] if len(sys.argv) > 1 else date.today().isoformat()
init_db()
with get_db() as conn:
    snaps = conn.execute(
        "SELECT s.id, s.printer_id, s.ts FROM snmp_snapshots s WHERE s.reachable = 1 AND s.ts >= ?"
        " AND NOT EXISTS (SELECT 1 FROM toner_events e WHERE e.printer_id = s.printer_id AND e.ts = s.ts)"
        " ORDER BY s.id", (since,)).fetchall()
    found = sum(replacements.detect(conn, s["printer_id"], s["id"]) for s in snaps)
    print(f"checked {len(snaps)} readings since {since}: {found} replacement(s) logged for review")
