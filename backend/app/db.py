import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .config import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS printers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL UNIQUE,
    color_type TEXT NOT NULL DEFAULT 'Krāsains',
    snmp_enabled INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT ''
);
-- Each user's own printer order ("Pielāgota secība"); printers without a row come after, by company/location.
CREATE TABLE IF NOT EXISTS user_printer_order (
    username TEXT NOT NULL,
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (username, printer_id)
);
-- Logins. Roles: admin | standard — same rights in the app, only an admin manages users (auth.py).
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'standard',
    created_ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
    created_by TEXT
);
-- Push notifications (push.py): one row per browser/phone that turned them on;
-- app_kv holds server-wide values (the VAPID key pair); push_state remembers which problems were already
-- announced, so a printer that stays offline is reported once, not at every poll.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    device TEXT NOT NULL DEFAULT '',
    created_ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
);
CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_state (key TEXT PRIMARY KEY, since_ts TEXT NOT NULL);
-- Small per-user settings, e.g. the order e-mail template (settings.py).
CREATE TABLE IF NOT EXISTS user_settings (
    username TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (username, key)
);
CREATE TABLE IF NOT EXISTS toner_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'toner'
);
CREATE TABLE IF NOT EXISTS printer_toners (
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    toner_id INTEGER NOT NULL REFERENCES toner_models(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL DEFAULT 0,
    optimal_qty INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (printer_id, toner_id)
);
CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
);
-- Where a printer's cartridges physically are. printer_toners.qty is kept equal to the sum of these.
CREATE TABLE IF NOT EXISTS stock_locations (
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    toner_id INTEGER NOT NULL REFERENCES toner_models(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id),
    qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
    PRIMARY KEY (printer_id, toner_id, location_id)
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    toner_id INTEGER NOT NULL REFERENCES toner_models(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL CHECK (qty > 0),
    status TEXT NOT NULL DEFAULT 'ordered',  -- ordered | received | cancelled (+ defect: warranty, not handed over yet)
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
    resolved_by TEXT,
    resolved_ts TEXT,
    received_qty INTEGER,
    -- Warranty claim instead of a purchase. It starts as status 'defect' (on the "Defekti" list, nothing expected
    -- yet); "Nodots garantijā" makes it 'ordered' (handed over, replacement expected — sent_ts/sent_by), then
    -- received = replacement arrived, cancelled = rejected.
    warranty INTEGER NOT NULL DEFAULT 0,
    sent_ts TEXT,
    sent_by TEXT,
    removed_pct INTEGER,                -- toner level when it was taken out, if known
    defect TEXT NOT NULL DEFAULT ''     -- what was wrong, e.g. "Smērē"
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    toner_id INTEGER NOT NULL REFERENCES toner_models(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
);
-- Toner replacements detected from SNMP (level jumped up). Reviewed in Žurnāls: confirm (= mark used) or dismiss.
CREATE TABLE IF NOT EXISTS toner_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    toner_id INTEGER REFERENCES toner_models(id) ON DELETE SET NULL,  -- NULL if no linked cartridge matches the colour
    supply TEXT NOT NULL,          -- SNMP supply description, e.g. "Black Cartridge HP CF360X"
    color TEXT NOT NULL DEFAULT '',
    from_pct INTEGER NOT NULL,
    to_pct INTEGER NOT NULL,
    ts TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',  -- open | confirmed | dismissed
    resolved_by TEXT,
    resolved_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_toner_events_status ON toner_events(status);
CREATE TABLE IF NOT EXISTS snmp_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    reachable INTEGER NOT NULL DEFAULT 1,
    hostname TEXT NOT NULL DEFAULT '',
    serial TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    uptime_hours REAL,
    page_count INTEGER,
    alerts TEXT NOT NULL DEFAULT '',
    blocking TEXT NOT NULL DEFAULT '',  -- why it can't print (" | "-joined); empty = it can
    attention TEXT NOT NULL DEFAULT ''  -- prints, but needs looking at (maintenance)
);
CREATE INDEX IF NOT EXISTS idx_snap_printer_ts ON snmp_snapshots(printer_id, ts DESC);
CREATE TABLE IF NOT EXISTS snmp_supplies (
    snapshot_id INTEGER NOT NULL REFERENCES snmp_snapshots(id) ON DELETE CASCADE,
    idx TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    level INTEGER,
    max_capacity INTEGER,
    pct INTEGER
);
CREATE INDEX IF NOT EXISTS idx_supplies_snap ON snmp_supplies(snapshot_id);
"""


def connect() -> sqlite3.Connection:
    Path(config["db_path"]).parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False: FastAPI may open the connection (dependency) on one worker thread and
    # run the endpoint on another. Each request gets its own connection and never shares it, so this is safe;
    # without it, concurrent page loads failed at random with a 500.
    conn = sqlite3.connect(config["db_path"], timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def get_db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def db_dep():
    with get_db() as conn:
        yield conn


DEFAULT_LOCATIONS = ("SP Noliktava", "LI Servertelpa")
UNASSIGNED = "Nav norādīts"


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def init_db() -> None:
    with get_db() as conn:
        conn.executescript(SCHEMA)

        # Columns added after the first release (CREATE TABLE IF NOT EXISTS doesn't add them).
        if "default_location_id" not in _columns(conn, "printers"):
            conn.execute("ALTER TABLE printers ADD COLUMN default_location_id INTEGER"
                         " REFERENCES locations(id) ON DELETE SET NULL")
        if "short" not in _columns(conn, "locations"):  # short display name for tight spaces (toner rows)
            conn.execute("ALTER TABLE locations ADD COLUMN short TEXT NOT NULL DEFAULT ''")
        scols = _columns(conn, "snmp_snapshots")
        if "blocking" not in scols:
            conn.execute("ALTER TABLE snmp_snapshots ADD COLUMN blocking TEXT NOT NULL DEFAULT ''")
        if "attention" not in scols:
            conn.execute("ALTER TABLE snmp_snapshots ADD COLUMN attention TEXT NOT NULL DEFAULT ''")
        ocols = _columns(conn, "orders")  # warranty claims (a second kind of order)
        if "warranty" not in ocols:
            conn.execute("ALTER TABLE orders ADD COLUMN warranty INTEGER NOT NULL DEFAULT 0")
        if "removed_pct" not in ocols:
            conn.execute("ALTER TABLE orders ADD COLUMN removed_pct INTEGER")
        if "defect" not in ocols:
            conn.execute("ALTER TABLE orders ADD COLUMN defect TEXT NOT NULL DEFAULT ''")
        if "sent_ts" not in ocols:
            conn.execute("ALTER TABLE orders ADD COLUMN sent_ts TEXT")
            conn.execute("ALTER TABLE orders ADD COLUMN sent_by TEXT")
        mcols = _columns(conn, "stock_movements")
        if "location_id" not in mcols:
            conn.execute("ALTER TABLE stock_movements ADD COLUMN location_id INTEGER")
        if "to_location_id" not in mcols:
            conn.execute("ALTER TABLE stock_movements ADD COLUMN to_location_id INTEGER")

        # Pins were replaced by a custom order: each user's pinned printers (in pin order) become the
        # start of their order, the rest follow as before.
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_pins'").fetchone():
            conn.execute(
                "INSERT OR IGNORE INTO user_printer_order (username, printer_id, position)"
                " SELECT username, printer_id, (SELECT COUNT(*) FROM user_pins p2"
                "  WHERE p2.username = p.username AND p2.rowid < p.rowid) FROM user_pins p")
            conn.execute("DROP TABLE user_pins")

        if conn.execute("SELECT COUNT(*) FROM locations").fetchone()[0] == 0:
            conn.executemany("INSERT INTO locations (name, sort) VALUES (?, ?)",
                             [(n, i) for i, n in enumerate(DEFAULT_LOCATIONS)])

        # Any stock not yet placed in a location (existing data, Excel imports) goes to "Nav norādīts",
        # so totals never silently change; the user then moves it to the real place.
        unplaced = conn.execute(
            "SELECT pt.printer_id, pt.toner_id, pt.qty - COALESCE((SELECT SUM(sl.qty) FROM stock_locations sl"
            " WHERE sl.printer_id = pt.printer_id AND sl.toner_id = pt.toner_id), 0) AS rest"
            " FROM printer_toners pt").fetchall()
        unplaced = [r for r in unplaced if r["rest"] > 0]
        if unplaced:
            conn.execute("INSERT OR IGNORE INTO locations (name, sort) VALUES (?, 99)", (UNASSIGNED,))
            conn.execute("UPDATE locations SET active = 1 WHERE name = ?", (UNASSIGNED,))
            loc = conn.execute("SELECT id FROM locations WHERE name = ?", (UNASSIGNED,)).fetchone()["id"]
            for r in unplaced:
                conn.execute(
                    "INSERT INTO stock_locations (printer_id, toner_id, location_id, qty) VALUES (?,?,?,?)"
                    " ON CONFLICT(printer_id, toner_id, location_id) DO UPDATE SET qty = qty + excluded.qty",
                    (r["printer_id"], r["toner_id"], loc, r["rest"]))

