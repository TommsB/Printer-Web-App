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
    ip TEXT UNIQUE,  -- NULL = not on the network: only its toner reserve is tracked, never polled
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
-- Who is logged in where (auth.py). Kept here so an update or restart of the app doesn't log everyone out.
-- Only a hash of the cookie's token is stored: a copy of the database can't be used to log in as someone.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    expires_ts TEXT NOT NULL  -- UTC, ISO
);
-- The page counter at the end of each day, kept for good (snmp_snapshots only go back snapshot_keep_days):
-- what "pages per month" is worked out from (printers.py → usage).
CREATE TABLE IF NOT EXISTS page_counts (
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    day TEXT NOT NULL,  -- YYYY-MM-DD, local
    page_count INTEGER NOT NULL,
    PRIMARY KEY (printer_id, day)
);
-- Every supply's level at the end of each day, kept for good like page_counts: what the "Analītika" charts
-- are drawn from (printers.py → analytics), also further back than the readings themselves are kept.
CREATE TABLE IF NOT EXISTS supply_days (
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    day TEXT NOT NULL,  -- YYYY-MM-DD, local
    idx TEXT NOT NULL,
    description TEXT NOT NULL,
    pct INTEGER NOT NULL,
    PRIMARY KEY (printer_id, day, idx, description)
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
-- The bell button's history: one row per user per notification they were told about (whether or not they
-- have push on), so each user can delete theirs and has their own notification hours.
CREATE TABLE IF NOT EXISTS push_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '/',
    username TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS push_state (key TEXT PRIMARY KEY, since_ts TEXT NOT NULL);
-- Notifications held back because they came up outside a user's notification hours. Delivered when their
-- hours start, unless the problem (key = its push_state key) is gone by then.
CREATE TABLE IF NOT EXISTS push_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    key TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '/',
    tag TEXT NOT NULL DEFAULT '',
    created_ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
);
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
    status TEXT NOT NULL DEFAULT 'ordered',  -- planned (in the basket) | ordered | received | cancelled (+ defect: warranty, not handed over yet)
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
-- Empty cartridges waiting to be handed back to the supplier (empties.py): a count per storage place and
-- kind (toner | drum), not per code. empties_log keeps every change; movement_id ties an empty to the
-- "Izlietots" that produced it, so undoing that takes the empty away again.
CREATE TABLE IF NOT EXISTS empties (
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty >= 0),
    PRIMARY KEY (location_id, kind)
);
CREATE TABLE IF NOT EXISTS empties_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
    username TEXT NOT NULL,
    kind TEXT NOT NULL,
    location_id INTEGER,
    to_location_id INTEGER,            -- only for 'moved'
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,              -- used | returned | moved | correction
    note TEXT NOT NULL DEFAULT '',
    movement_id INTEGER
);
-- Photos / documents attached to a defect (attachments.py). The files themselves are on disk next to the
-- database (data/attachments/<stored>); `name` is what the user called the file.
CREATE TABLE IF NOT EXISTS order_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    stored TEXT NOT NULL UNIQUE,
    uploaded_by TEXT NOT NULL,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_order_files_order ON order_files(order_id);
-- Delivery notes ("pavadzīmes") and other documents that come with a delivery. One document covers several
-- orders (all of one company's cartridges in that delivery), so it is linked to each of them.
CREATE TABLE IF NOT EXISTS delivery_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    stored TEXT NOT NULL UNIQUE,
    uploaded_by TEXT NOT NULL,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
);
CREATE TABLE IF NOT EXISTS delivery_doc_orders (
    doc_id INTEGER NOT NULL REFERENCES delivery_docs(id) ON DELETE CASCADE,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    PRIMARY KEY (doc_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_doc_orders_order ON delivery_doc_orders(order_id);
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
-- Toner and drum replacements detected from SNMP (level jumped up). Reviewed in Žurnāls: confirm (= mark used) or dismiss.
CREATE TABLE IF NOT EXISTS toner_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    toner_id INTEGER REFERENCES toner_models(id) ON DELETE SET NULL,  -- NULL if no linked item of that kind matches the colour
    supply TEXT NOT NULL,          -- SNMP supply description, e.g. "Black Cartridge HP CF360X"
    color TEXT NOT NULL DEFAULT '',  -- K/C/M/Y; '' for a drum the printer reports without a colour
    from_pct INTEGER NOT NULL,
    to_pct INTEGER NOT NULL,
    ts TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',  -- open | confirmed | dismissed
    resolved_by TEXT,
    resolved_ts TEXT,
    kind TEXT NOT NULL DEFAULT 'toner'  -- toner | drum: what was replaced (same values as toner_models.kind)
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


def _make_ip_optional() -> None:
    """printers.ip used to be NOT NULL; a printer that isn't on the network has none. SQLite can't drop
    NOT NULL from a column, so the table is rebuilt the documented way: foreign keys off (otherwise dropping
    the old table would cascade into the reserve and history), copy, swap, check — all in one transaction."""
    conn = connect()
    try:
        ip = next((r for r in conn.execute("PRAGMA table_info(printers)") if r["name"] == "ip"), None)
        if ip is None or not ip["notnull"]:
            return  # new database, or already done
        old = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'printers'").fetchone()[0]
        new = old.replace("CREATE TABLE printers", "CREATE TABLE printers_new", 1) \
                 .replace("ip TEXT NOT NULL UNIQUE", "ip TEXT UNIQUE", 1)
        if "printers_new" not in new or "ip TEXT UNIQUE" not in new:
            raise RuntimeError("printers table has an unexpected definition; ip left as required")
        conn.isolation_level = None  # explicit BEGIN/COMMIT below
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(new)
            conn.execute("INSERT INTO printers_new SELECT * FROM printers")
            conn.execute("DROP TABLE printers")
            conn.execute("ALTER TABLE printers_new RENAME TO printers")
            if conn.execute("PRAGMA foreign_key_check").fetchall():
                raise RuntimeError("foreign key check failed while rebuilding printers")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()


def _split_push_log_per_user(conn: sqlite3.Connection) -> None:
    """The notification history used to be one list shared by everyone. Give every user their own copy of
    it (and move their "seen up to here" mark to the matching copy), then drop the shared rows."""
    if "username" not in _columns(conn, "push_log"):
        conn.execute("ALTER TABLE push_log ADD COLUMN username TEXT NOT NULL DEFAULT ''")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_push_log_user ON push_log(username, id)")
    shared = conn.execute("SELECT id, ts, category, title, body, url FROM push_log WHERE username = '' ORDER BY id").fetchall()
    if not shared:
        return
    for (username,) in conn.execute("SELECT username FROM users").fetchall():
        row = conn.execute("SELECT value FROM user_settings WHERE username = ? AND key = 'push_seen_id'", (username,)).fetchone()
        try:
            old_seen = int(row[0]) if row else 0
        except ValueError:
            old_seen = 0
        new_seen = 0
        for r in shared:
            new_id = conn.execute("INSERT INTO push_log (ts, category, title, body, url, username) VALUES (?,?,?,?,?,?)",
                                  (r["ts"], r["category"], r["title"], r["body"], r["url"], username)).lastrowid
            if r["id"] <= old_seen:
                new_seen = new_id
        # The copies have new (higher) ids: without this, everything already read would count as unread again.
        conn.execute("INSERT INTO user_settings (username, key, value) VALUES (?, 'push_seen_id', ?)"
                     " ON CONFLICT(username, key) DO UPDATE SET value = excluded.value", (username, str(new_seen)))
    conn.execute("DELETE FROM push_log WHERE username = ''")


def init_db() -> None:
    _make_ip_optional()
    with get_db() as conn:
        conn.executescript(SCHEMA)

        # Columns added after the first release (CREATE TABLE IF NOT EXISTS doesn't add them).
        if "default_location_id" not in _columns(conn, "printers"):
            conn.execute("ALTER TABLE printers ADD COLUMN default_location_id INTEGER"
                         " REFERENCES locations(id) ON DELETE SET NULL")
        if "empties_location_id" not in _columns(conn, "printers"):  # where this printer's empty cartridges go by default
            conn.execute("ALTER TABLE printers ADD COLUMN empties_location_id INTEGER"
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
        if "extra" not in ocols:  # ordered from the basket's "papildus" part: on top of the norm, see orders.py
            conn.execute("ALTER TABLE orders ADD COLUMN extra INTEGER NOT NULL DEFAULT 0")
        if "pages_printed" not in ocols:  # defects: what the cartridge printed, since when, where it is kept
            conn.execute("ALTER TABLE orders ADD COLUMN pages_printed INTEGER")
            conn.execute("ALTER TABLE orders ADD COLUMN installed_ts TEXT")
            conn.execute("ALTER TABLE orders ADD COLUMN held_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL")
        mcols = _columns(conn, "stock_movements")
        if "location_id" not in mcols:
            conn.execute("ALTER TABLE stock_movements ADD COLUMN location_id INTEGER")
        if "to_location_id" not in mcols:
            conn.execute("ALTER TABLE stock_movements ADD COLUMN to_location_id INTEGER")

        _split_push_log_per_user(conn)
        if "kind" not in _columns(conn, "toner_events"):  # drum replacements are detected too (replacements.py)
            conn.execute("ALTER TABLE toner_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'toner'")

        # Pins were replaced by a custom order: each user's pinned printers (in pin order) become the
        # start of their order, the rest follow as before.
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_pins'").fetchone():
            conn.execute(
                "INSERT OR IGNORE INTO user_printer_order (username, printer_id, position)"
                " SELECT username, printer_id, (SELECT COUNT(*) FROM user_pins p2"
                "  WHERE p2.username = p.username AND p2.rowid < p.rowid) FROM user_pins p")
            conn.execute("DROP TABLE user_pins")

        # First start with page_counts: fill it from the readings that are still kept, so the monthly
        # figures don't start from nothing.
        if not conn.execute("SELECT 1 FROM page_counts LIMIT 1").fetchone():
            conn.execute(
                "INSERT OR IGNORE INTO page_counts (printer_id, day, page_count)"
                " SELECT printer_id, substr(ts, 1, 10), page_count FROM snmp_snapshots WHERE id IN ("
                "  SELECT MAX(id) FROM snmp_snapshots WHERE reachable = 1 AND page_count IS NOT NULL"
                "  GROUP BY printer_id, substr(ts, 1, 10))")

        # Same for supply_days: the levels of the days whose readings are still kept.
        if not conn.execute("SELECT 1 FROM supply_days LIMIT 1").fetchone():
            conn.execute(
                "INSERT OR IGNORE INTO supply_days (printer_id, day, idx, description, pct)"
                " SELECT s.printer_id, substr(s.ts, 1, 10), u.idx, u.description, u.pct FROM snmp_snapshots s"
                " JOIN snmp_supplies u ON u.snapshot_id = s.id WHERE u.pct IS NOT NULL AND s.id IN ("
                "  SELECT MAX(id) FROM snmp_snapshots WHERE reachable = 1 GROUP BY printer_id, substr(ts, 1, 10))")

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

