"""Printers that may fall asleep ("Printeris var aizmigt", printers.can_sleep).

Some printers go into a deep sleep (HP "Auto Off") about two hours after their last job and then don't answer
SNMP at all: every evening, every weekend, a quiet afternoon. For them, not answering is normal and is shown as
"Miega režīmā", not reported as "nav pieejams".

A real failure (power, cable, a new IP address) is still caught once a day: such printers are set to wake up on
a schedule on working days, so on a weekday from WAKE_CHECK on, a printer that hasn't answered once since
midnight is really unreachable (push.after_poll announces it, the app shows it red).
"""

import sqlite3
from datetime import datetime, time

WAKE_CHECK = time(8, 0)  # weekdays: by now a printer that may sleep must have answered at least once today


def overdue(conn: sqlite3.Connection, printer_id: int, now: datetime | None = None) -> bool:
    """A printer that may sleep and should be awake by now, but hasn't answered once today."""
    now = now or datetime.now()
    if now.weekday() >= 5 or now.time() < WAKE_CHECK:  # Sat/Sun, or before the check on a weekday
        return False
    answered = conn.execute(
        "SELECT 1 FROM snmp_snapshots WHERE printer_id = ? AND reachable = 1 AND ts >= ? LIMIT 1",
        (printer_id, now.date().isoformat())).fetchone()
    return answered is None
