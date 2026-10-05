"""Push notifications (Web Push) to the phones/browsers that turned them on.

Three kinds, each user picks which they want (stored per user, applies to all their devices):
  printer      a printer can't print (jam, door open, no paper…) or stopped answering
  replacement  a toner replacement was detected and waits in Vēsture → Jāpārbauda
  toner        a toner is nearly empty and there is no spare in the reserve

How it works: after every SNMP poll, `after_poll` looks at what changed and returns the messages to send;
`dispatch` then delivers them in a background thread. `push_state` remembers what was already announced,
so a problem is reported once when it starts — not again at every poll while it lasts.

Needs https (browsers only allow push there) and outbound internet from the server to the push services
(Apple, Google, Mozilla). The VAPID key pair that identifies this server is created on first use and kept
in the database (app_kv).
"""

import base64
import json
import sqlite3
import threading
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import current_username
from .config import config
from .db import db_dep, get_db
from .replacements import toner_color

router = APIRouter(prefix="/api/push", tags=["push"])

CATEGORIES = ("printer", "replacement", "toner")
PREFS_KEY = "push_prefs"
SEEN_KEY = "push_seen_id"  # per user: the newest history entry they have looked at (for the unread badge)
HISTORY_KEEP = 300  # how many past notifications the history keeps
HISTORY_SHOWN = 60
LOW_PCT = 15  # same threshold as the orange toner bars in the app


@dataclass
class Message:
    category: str
    title: str
    body: str
    url: str = "/"
    tag: str = ""  # a newer notification with the same tag replaces the older one on the device


# ---- keys -----------------------------------------------------------------------------------

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def vapid_keys(conn: sqlite3.Connection) -> tuple[str, str]:
    """(private, public) VAPID keys as base64url; generated and stored on first use."""
    rows = dict(conn.execute("SELECT key, value FROM app_kv WHERE key IN ('vapid_private', 'vapid_public')").fetchall())
    if "vapid_private" not in rows or "vapid_public" not in rows:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        key = ec.generate_private_key(ec.SECP256R1())
        rows = {
            "vapid_private": _b64url(key.private_numbers().private_value.to_bytes(32, "big")),
            "vapid_public": _b64url(key.public_key().public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)),
        }
        conn.executemany("INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)", list(rows.items()))
    return rows["vapid_private"], rows["vapid_public"]


def _contact() -> str:
    """Who runs this server — the push services require it, and Apple rejects the request (403 BadJwtToken)
    if it isn't a real-looking `mailto:` address or https URL. PUSH_CONTACT wins; else the app's https address."""
    contact = config["push_contact"].strip()
    if contact:
        return contact if contact.lower().startswith(("mailto:", "https://")) else f"mailto:{contact}"
    url = config["public_url"].strip()
    return url if url.lower().startswith("https://") else "mailto:printeri@localhost.localdomain"


# ---- sending --------------------------------------------------------------------------------

def _send_detail(sub: dict, payload: str, private_key: str) -> tuple[int, str]:
    """Deliver one notification. Returns the push service's HTTP status (0 = couldn't reach it) and, when it
    refused, the reason it gave (e.g. Apple's {"reason":"BadJwtToken"})."""
    from pywebpush import WebPushException, webpush
    try:
        webpush(subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                data=payload, vapid_private_key=private_key, vapid_claims={"sub": _contact()}, ttl=6 * 3600, timeout=10)
        return 201, ""
    except WebPushException as e:
        if e.response is None:
            print(f"[push] send failed: {e}")
            return 0, str(e)[:200]
        reason = (e.response.text or "").strip()[:300]
        host = sub["endpoint"].split("/")[2] if "//" in sub["endpoint"] else "?"
        print(f"[push] {host} answered {e.response.status_code}: {reason} (contact: {_contact()})")
        return e.response.status_code, reason
    except Exception as e:  # network trouble etc. must never break the caller
        print(f"[push] send failed: {e}")
        return 0, str(e)[:200]


def _send(sub: dict, payload: str, private_key: str) -> int:
    return _send_detail(sub, payload, private_key)[0]


def _payload(m: Message) -> str:
    return json.dumps({"title": m.title, "body": m.body, "url": m.url, "tag": m.tag}, ensure_ascii=False)


def _forget(endpoints: list[str]) -> None:
    """The push service says these devices are gone (app removed, permission withdrawn): drop them."""
    if endpoints:
        with get_db() as conn:
            conn.executemany("DELETE FROM push_subscriptions WHERE endpoint = ?", [(e,) for e in endpoints])


def _prefs(conn: sqlite3.Connection, username: str) -> dict[str, bool]:
    row = conn.execute("SELECT value FROM user_settings WHERE username = ? AND key = ?", (username, PREFS_KEY)).fetchone()
    saved = {}
    if row:
        try:
            saved = json.loads(row["value"])
        except ValueError:
            pass
    return {c: bool(saved.get(c, True)) for c in CATEGORIES}  # everything on unless switched off


def dispatch(messages: list[Message]) -> None:
    """Send each message to every device whose user wants that kind. Returns at once; delivery runs in the
    background so a slow push service never holds up polling."""
    if not messages:
        return
    with get_db() as conn:
        # The history (bell button) gets every announcement, also when nobody has push switched on.
        conn.executemany("INSERT INTO push_log (category, title, body, url) VALUES (?,?,?,?)",
                         [(m.category, m.title, m.body, m.url) for m in messages])
        conn.execute("DELETE FROM push_log WHERE id <= (SELECT MAX(id) FROM push_log) - ?", (HISTORY_KEEP,))
        subs = [dict(r) for r in conn.execute("SELECT endpoint, username, p256dh, auth FROM push_subscriptions")]
        if not subs:
            return
        private_key, _ = vapid_keys(conn)
        prefs = {u: _prefs(conn, u) for u in {s["username"] for s in subs}}

    def run() -> None:
        gone = []
        for m in messages:
            payload = _payload(m)
            for s in subs:
                if prefs[s["username"]].get(m.category, True) and s["endpoint"] not in gone:
                    if _send(s, payload, private_key) in (404, 410):
                        gone.append(s["endpoint"])
        _forget(gone)

    threading.Thread(target=run, daemon=True).start()


# ---- what to announce after a poll ------------------------------------------------------------

def _kv(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM app_kv WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def after_poll(conn: sqlite3.Connection, printer_ids: list[int]) -> list[Message]:
    """Compare the fresh readings with what was already announced. Updates push_state (in the caller's
    transaction) and returns the notifications to send. The very first run only records the current
    situation, so switching this on doesn't flood everyone with old problems."""
    first_run = _kv(conn, "push_seen") is None
    announced = {r["key"] for r in conn.execute("SELECT key FROM push_state")}
    out: list[Message] = []

    def start(key: str, message: Message) -> None:  # a problem is present
        if key not in announced:
            conn.execute("INSERT OR REPLACE INTO push_state (key, since_ts) VALUES (?, strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))", (key,))
            announced.add(key)
            out.append(message)

    def stop(key: str) -> None:  # the problem is gone: it may be announced again next time
        if key in announced:
            conn.execute("DELETE FROM push_state WHERE key = ?", (key,))
            announced.discard(key)

    for pid in printer_ids:
        printer = conn.execute("SELECT location, color_type FROM printers WHERE id = ?", (pid,)).fetchone()
        snaps = conn.execute("SELECT id, reachable, blocking FROM snmp_snapshots WHERE printer_id = ?"
                             " ORDER BY id DESC LIMIT 2", (pid,)).fetchall()
        if not printer or not snaps:
            continue
        name, cur = printer["location"], snaps[0]
        url = f"/?p={pid}"

        if not cur["reachable"]:
            # One missed poll happens (sleep, a network blip). Two in a row = really not answering.
            if len(snaps) > 1 and not snaps[1]["reachable"]:
                start(f"offline:{pid}", Message("printer", f"{name}: nav pieejams",
                                                "Printeris neatbild jau divas aptaujas pēc kārtas.", url, f"printer-{pid}"))
            continue  # no readings to judge the rest by
        stop(f"offline:{pid}")

        if cur["blocking"]:
            start(f"blocked:{pid}", Message("printer", f"{name}: nevar drukāt",
                                            cur["blocking"].replace(" | ", ", "), url, f"printer-{pid}"))
        else:
            stop(f"blocked:{pid}")

        # Nearly empty toner with nothing in the reserve.
        mono = printer["color_type"] == "Melnbalts"
        linked = conn.execute(
            "SELECT t.id, t.code, UPPER(t.color) AS color, pt.qty,"
            " (SELECT COALESCE(SUM(o.qty), 0) FROM orders o WHERE o.status = 'ordered'"
            "  AND o.printer_id = pt.printer_id AND o.toner_id = pt.toner_id) AS ordered"
            " FROM printer_toners pt JOIN toner_models t ON t.id = pt.toner_id WHERE pt.printer_id = ?", (pid,)).fetchall()
        low_now = set()
        for s in conn.execute("SELECT description, pct FROM snmp_supplies WHERE snapshot_id = ?", (cur["id"],)):
            col = toner_color(s["description"], mono)
            if col is None or s["pct"] is None or s["pct"] >= LOW_PCT:
                continue
            match = [t for t in linked if t["color"] == col] or (list(linked) if mono and len(linked) == 1 else [])
            if match and match[0]["qty"] == 0:
                t = match[0]
                low_now.add(t["id"])
                on_order = f" Pasūtīts ×{t['ordered']}." if t["ordered"] else " Nekas nav pasūtīts."
                start(f"lowtoner:{pid}:{t['id']}", Message(
                    "toner", f"{name}: beidzas toneris", f"{t['code']} — {s['pct']}%, rezervē nav neviena.{on_order}",
                    "/stock", f"toner-{pid}-{t['id']}"))
        for t in linked:
            if t["id"] not in low_now:
                stop(f"lowtoner:{pid}:{t['id']}")

    # Newly detected replacements (they wait in Vēsture → Jāpārbauda).
    last = int(_kv(conn, "push_last_event") or 0)
    events = conn.execute(
        "SELECT e.id, e.color, e.from_pct, e.to_pct, p.location, t.code FROM toner_events e"
        " JOIN printers p ON p.id = e.printer_id LEFT JOIN toner_models t ON t.id = e.toner_id"
        " WHERE e.id > ? AND e.status = 'open' ORDER BY e.id", (last,)).fetchall()
    for e in events:
        out.append(Message("replacement", f"{e['location']}: nomainīts toneris",
                           f"{e['code'] or e['color']} {e['from_pct']}% → {e['to_pct']}%. Apstipriniet sadaļā Vēsture.",
                           "/log", f"event-{e['id']}"))
    newest = conn.execute("SELECT COALESCE(MAX(id), 0) FROM toner_events").fetchone()[0]
    conn.execute("INSERT OR REPLACE INTO app_kv (key, value) VALUES ('push_last_event', ?)", (str(newest),))

    if first_run:
        conn.execute("INSERT OR REPLACE INTO app_kv (key, value) VALUES ('push_seen', '1')")
        return []
    return out


# ---- API (the profile window) ------------------------------------------------------------------

class SubscriptionKeys(BaseModel):
    p256dh: str = Field(min_length=1, max_length=300)
    auth: str = Field(min_length=1, max_length=100)


class SubscribeIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=2000)
    keys: SubscriptionKeys
    device: str = Field(default="", max_length=200)


class EndpointIn(BaseModel):
    endpoint: str


class PrefsIn(BaseModel):
    printer: bool = True
    replacement: bool = True
    toner: bool = True


@router.get("")
def status(conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    _, public_key = vapid_keys(conn)
    endpoints = [r["endpoint"] for r in conn.execute("SELECT endpoint FROM push_subscriptions WHERE username = ?", (username,))]
    return {"public_key": public_key, "prefs": _prefs(conn, username), "endpoints": endpoints}


@router.post("/subscribe")
def subscribe(body: SubscribeIn, conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    if not body.endpoint.lower().startswith("https://"):
        raise HTTPException(400, "Nederīga paziņojumu adrese")
    # A device belongs to whoever enabled notifications on it last.
    conn.execute(
        "INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, device) VALUES (?,?,?,?,?)"
        " ON CONFLICT(endpoint) DO UPDATE SET username = excluded.username, p256dh = excluded.p256dh,"
        " auth = excluded.auth, device = excluded.device",
        (body.endpoint, username, body.keys.p256dh, body.keys.auth, body.device))
    return {"ok": True}


@router.post("/unsubscribe")
def unsubscribe(body: EndpointIn, conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ? AND username = ?", (body.endpoint, username))
    return {"ok": True}


@router.put("/prefs")
def set_prefs(body: PrefsIn, conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    prefs = {c: getattr(body, c) for c in CATEGORIES}
    conn.execute("INSERT INTO user_settings (username, key, value) VALUES (?,?,?)"
                 " ON CONFLICT(username, key) DO UPDATE SET value = excluded.value", (username, PREFS_KEY, json.dumps(prefs)))
    return prefs


class SeenIn(BaseModel):
    id: int


def _seen(conn: sqlite3.Connection, username: str) -> int:
    row = conn.execute("SELECT value FROM user_settings WHERE username = ? AND key = ?", (username, SEEN_KEY)).fetchone()
    try:
        return int(row["value"]) if row else 0
    except ValueError:
        return 0


@router.get("/history")
def history(conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    """The latest announcements (newest first) and how many of them this user hasn't opened the list for yet.
    Everyone sees the same history, whatever kinds they chose to be pushed."""
    seen = _seen(conn, username)
    items = [dict(r) for r in conn.execute(
        "SELECT id, ts, category, title, body, url FROM push_log ORDER BY id DESC LIMIT ?", (HISTORY_SHOWN,))]
    unread = conn.execute("SELECT COUNT(*) FROM push_log WHERE id > ?", (seen,)).fetchone()[0]
    return {"items": items, "seen": seen, "unread": unread}


@router.post("/seen")
def mark_seen(body: SeenIn, conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    """The user opened the list: everything up to `id` counts as read (never moves backwards)."""
    seen = max(_seen(conn, username), body.id)
    conn.execute("INSERT INTO user_settings (username, key, value) VALUES (?,?,?)"
                 " ON CONFLICT(username, key) DO UPDATE SET value = excluded.value", (username, SEEN_KEY, str(seen)))
    return {"seen": seen}


@router.post("/test")
def send_test(body: EndpointIn, conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    """Send a test notification to this device and report whether the push service accepted it."""
    sub = conn.execute("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ? AND username = ?",
                       (body.endpoint, username)).fetchone()
    if not sub:
        raise HTTPException(404, "Šai ierīcei paziņojumi nav ieslēgti")
    private_key, _ = vapid_keys(conn)
    code, reason = _send_detail(dict(sub), _payload(Message("printer", "Printeri: tests", "Paziņojumi šajā ierīcē darbojas.", "/", "test")), private_key)
    if code in (404, 410):
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (body.endpoint,))
    return {"ok": 200 <= code < 300, "status": code, "reason": reason, "contact": _contact()}
