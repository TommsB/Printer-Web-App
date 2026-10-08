"""Push notifications (Web Push) to the phones/browsers that turned them on.

Three kinds, each user picks which they want (stored per user, applies to all their devices):
  printer      a printer can't print (jam, door open, no paper…) or stopped answering
  replacement  a toner or drum replacement was detected and waits in Vēsture → Jāpārbauda
  toner        the toner in a printer is below 40% — or its drum below 15% — (or forecast to run out within
               two weeks) and there is no spare in the reserve ("zems pēdējais toneris" / "…drums")

How it works: after every SNMP poll, `after_poll` looks at what changed and returns the messages to send;
`dispatch` then delivers them in a background thread. `push_state` remembers what was already announced,
so a problem is reported once when it starts — not again at every poll while it lasts.

Notification hours: each user can limit notifications to a time of day and weekdays (`push_schedule`).
Outside those hours nothing is sent or added to their bell list; the message waits in `push_pending` and is
delivered when their hours start — unless the problem is over by then, in which case they never hear of it
(a printer switched off for the night and back in the morning stays silent).

The bell list (`push_log`) is per user: one row per notification that user was told about, which they can
delete one by one or all at once.

Needs https (browsers only allow push there) and outbound internet from the server to the push services
(Apple, Google, Mozilla). The VAPID key pair that identifies this server is created on first use and kept
in the database (app_kv).
"""

import base64
import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import forecast
from .auth import current_username
from .config import config
from .db import db_dep, get_db
from .replacements import classify, pick

router = APIRouter(prefix="/api/push", tags=["push"])

CATEGORIES = ("printer", "replacement", "toner")
PREFS_KEY = "push_prefs"
SEEN_KEY = "push_seen_id"  # per user: the newest history entry they have looked at (for the unread badge)
SCHEDULE_KEY = "push_schedule"  # per user: notification hours, see in_hours()
DEFAULT_SCHEDULE = {"enabled": False, "start": "08:00", "end": "17:00", "days": [0, 1, 2, 3, 4]}  # days: 0 = Monday
HISTORY_KEEP = 300  # how many past notifications each user's history keeps
HISTORY_SHOWN = 60
# "Low last toner": the cartridge in the printer is below this and there is no spare. Deliberately earlier
# than the app's orange toner bars (15%), so there is time to order before it runs out.
LOW_PCT = 40
# A drum wears out far more slowly, and printers keep working on a "worn" one for a long time: 40% would be
# months too early. So drums use the level of the app's orange bars, plus the same forecast rule.
DRUM_LOW_PCT = 15
LOW = {"toner": LOW_PCT, "drum": DRUM_LOW_PCT}  # the kinds that are watched; other supplies are not
NAME_LV = {"toner": "toneris", "drum": "drums"}
# …or, whatever the level, the forecast (forecast.py) says it will be empty within this many days.
SOON_DAYS = 14
SOON_MARGIN = 7  # once announced, it counts as gone only when the forecast is back above SOON_DAYS + this


@dataclass
class Message:
    category: str
    title: str
    body: str
    url: str = "/"
    tag: str = ""  # a newer notification with the same tag replaces the older one on the device
    key: str = ""  # what it is about (its push_state key, or event:<id>): a waiting message is dropped when that is over


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


def _schedule(conn: sqlite3.Connection, username: str) -> dict:
    row = conn.execute("SELECT value FROM user_settings WHERE username = ? AND key = ?", (username, SCHEDULE_KEY)).fetchone()
    saved = {}
    if row:
        try:
            saved = json.loads(row["value"])
        except ValueError:
            pass
    return {**DEFAULT_SCHEDULE, **{k: saved[k] for k in DEFAULT_SCHEDULE if k in saved}}


def in_hours(schedule: dict, now: datetime) -> bool:
    """Is `now` inside the user's notification hours? Off = always. "22:00–06:00" runs past midnight and
    belongs to the weekday it starts on; the same start and end means the whole day."""
    if not schedule["enabled"]:
        return True
    days, start, end = set(schedule["days"]), schedule["start"], schedule["end"]
    t, weekday = now.strftime("%H:%M"), now.weekday()
    if start == end:
        return weekday in days
    if start < end:
        return weekday in days and start <= t < end
    return (weekday in days and t >= start) or ((weekday - 1) % 7 in days and t < end)


def _waiting(conn: sqlite3.Connection, username: str, now: datetime) -> list[Message]:
    """Take this user's held-back messages (their hours have started). Ones whose problem is over are dropped."""
    rows = conn.execute("SELECT * FROM push_pending WHERE username = ? ORDER BY id", (username,)).fetchall()
    if not rows:
        return []
    conn.execute("DELETE FROM push_pending WHERE username = ?", (username,))
    active = {r["key"] for r in conn.execute("SELECT key FROM push_state")}
    out = []
    for r in rows:
        if r["key"].startswith("event:"):  # a detected replacement: only if nobody has confirmed it meanwhile
            event = conn.execute("SELECT status FROM toner_events WHERE id = ?", (r["key"][6:],)).fetchone()
            if not event or event["status"] != "open":
                continue
        elif r["key"] and r["key"] not in active:
            continue
        ts = r["created_ts"]
        when = ts[11:16] if ts[:10] == now.strftime("%Y-%m-%d") else f"{ts[8:10]}.{ts[5:7]}. {ts[11:16]}"
        since = f"Konstatēts {when}." if r["category"] == "replacement" else f"Kopš {when}."
        out.append(Message(r["category"], r["title"], f"{r['body']} {since}".strip(), r["url"], r["tag"], r["key"]))
    return out


def dispatch(messages: list[Message]) -> None:
    """Tell every user about each message: at once if it is within their notification hours, otherwise it
    waits for them. Also delivers what was waiting for users whose hours have started — so this is called
    after every poll, with or without new messages. Returns at once; delivery to the devices runs in the
    background so a slow push service never holds up polling."""
    now = datetime.now()
    with get_db() as conn:
        deliver: list[tuple[str, Message]] = []
        for username in [r["username"] for r in conn.execute("SELECT username FROM users")]:
            if in_hours(_schedule(conn, username), now):
                deliver += [(username, m) for m in _waiting(conn, username, now) + messages]
            else:
                conn.executemany(
                    "INSERT INTO push_pending (username, key, category, title, body, url, tag) VALUES (?,?,?,?,?,?,?)",
                    [(username, m.key, m.category, m.title, m.body, m.url, m.tag) for m in messages])
        if not deliver:
            return
        # The bell list gets every announcement, also for users without push switched on.
        conn.executemany("INSERT INTO push_log (username, category, title, body, url) VALUES (?,?,?,?,?)",
                         [(u, m.category, m.title, m.body, m.url) for u, m in deliver])
        for username in {u for u, _ in deliver}:
            conn.execute("DELETE FROM push_log WHERE username = ? AND id NOT IN"
                         " (SELECT id FROM push_log WHERE username = ? ORDER BY id DESC LIMIT ?)",
                         (username, username, HISTORY_KEEP))
        subs = [dict(r) for r in conn.execute("SELECT endpoint, username, p256dh, auth FROM push_subscriptions")]
        if not subs:
            return
        private_key, _ = vapid_keys(conn)
        prefs = {u: _prefs(conn, u) for u in {s["username"] for s in subs}}

    def run() -> None:
        gone = []
        for username, m in deliver:
            payload = _payload(m)
            for s in subs:
                if s["username"] == username and prefs[username].get(m.category, True) and s["endpoint"] not in gone:
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
        message.key = key
        if key not in announced:
            conn.execute("INSERT OR REPLACE INTO push_state (key, since_ts) VALUES (?, strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))", (key,))
            announced.add(key)
            out.append(message)

    def stop(key: str) -> None:  # the problem is gone: it may be announced again next time
        if key in announced:
            conn.execute("DELETE FROM push_state WHERE key = ?", (key,))
            conn.execute("DELETE FROM push_pending WHERE key = ?", (key,))  # whoever was still waiting to hear of it never will
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

        # The last toner or drum (nothing in the reserve) is getting low.
        mono = printer["color_type"] == "Melnbalts"
        linked = conn.execute(
            "SELECT t.id, t.code, t.kind, UPPER(t.color) AS color, pt.qty,"
            " (SELECT COALESCE(SUM(o.qty), 0) FROM orders o WHERE o.status = 'ordered'"
            "  AND o.printer_id = pt.printer_id AND o.toner_id = pt.toner_id) AS ordered"
            " FROM printer_toners pt JOIN toner_models t ON t.id = pt.toner_id WHERE pt.printer_id = ?", (pid,)).fetchall()
        # "Low" = below the limit for its kind, or the forecast says it runs out within SOON_DAYS (a busy
        # printer can be above 40% and still have only days left).
        left = forecast.days_left(conn, pid)
        low_now, hold = set(), set()
        for s in conn.execute("SELECT idx, description, pct FROM snmp_supplies WHERE snapshot_id = ?", (cur["id"],)):
            what = classify(s["description"], mono)
            if what is None or s["pct"] is None:
                continue
            kind, col = what
            days = left.get(s["idx"])
            t = pick(linked, kind, col, mono)  # the linked item of that kind and colour, never just "that colour"
            if t is None or t["qty"] != 0:
                continue
            if s["pct"] < LOW[kind] or (days is not None and days <= SOON_DAYS):
                low_now.add(t["id"])
                on_order = f" Pasūtīts ×{t['ordered']}." if t["ordered"] else " Nekas nav pasūtīts."
                lasts = f", pietiks ≈ {days} d" if days else ""  # no forecast, or already empty
                start(f"low{kind}:{pid}:{t['id']}", Message(
                    "toner", f"{name}: zems pēdējais {NAME_LV[kind]}",
                    f"{t['code']} — {s['pct']}%{lasts}. Rezervē nav neviena.{on_order}",
                    f"/stock?p={pid}", f"toner-{pid}-{t['id']}"))
            elif days is not None and days <= SOON_DAYS + SOON_MARGIN:
                hold.add(t["id"])  # the forecast wobbles around the limit: don't clear and re-announce
        for t in linked:
            if t["kind"] in LOW and t["id"] not in low_now and t["id"] not in hold:
                stop(f"low{t['kind']}:{pid}:{t['id']}")

    # Newly detected replacements (they wait in Vēsture → Jāpārbauda).
    last = int(_kv(conn, "push_last_event") or 0)
    events = conn.execute(
        "SELECT e.id, e.color, e.kind, e.from_pct, e.to_pct, p.location, t.code FROM toner_events e"
        " JOIN printers p ON p.id = e.printer_id LEFT JOIN toner_models t ON t.id = e.toner_id"
        " WHERE e.id > ? AND e.status = 'open' ORDER BY e.id", (last,)).fetchall()
    for e in events:
        out.append(Message("replacement", f"{e['location']}: nomainīts {NAME_LV.get(e['kind'], 'toneris')}",
                           f"{e['code'] or e['color']} {e['from_pct']}% → {e['to_pct']}%. Apstipriniet sadaļā Vēsture.".strip(),
                           f"/log?event={e['id']}", f"event-{e['id']}", f"event:{e['id']}"))
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


HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"


class ScheduleIn(BaseModel):
    enabled: bool
    start: str = Field(pattern=HHMM)
    end: str = Field(pattern=HHMM)
    days: list[int] = Field(max_length=7)


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
    return {"public_key": public_key, "prefs": _prefs(conn, username), "endpoints": endpoints,
            "schedule": _schedule(conn, username)}


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


@router.put("/schedule")
def set_schedule(body: ScheduleIn, conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    """Notification hours. Applies from the next poll on; switching it off (or widening it) delivers what was waiting."""
    days = sorted({d for d in body.days if 0 <= d <= 6})
    if len(days) != len(body.days):
        raise HTTPException(400, "Nederīga nedēļas diena")
    if body.enabled and not days:
        raise HTTPException(400, "Izvēlieties vismaz vienu dienu")
    schedule = {"enabled": body.enabled, "start": body.start, "end": body.end, "days": days}
    conn.execute("INSERT INTO user_settings (username, key, value) VALUES (?,?,?)"
                 " ON CONFLICT(username, key) DO UPDATE SET value = excluded.value", (username, SCHEDULE_KEY, json.dumps(schedule)))
    conn.commit()  # before answering, see delete_history_item
    return schedule


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
    """This user's latest notifications (newest first) and how many of them they haven't opened the list for
    yet. All kinds are listed, whichever ones they chose to be pushed to their devices."""
    seen = _seen(conn, username)
    items = [dict(r) for r in conn.execute(
        "SELECT id, ts, category, title, body, url FROM push_log WHERE username = ? ORDER BY id DESC LIMIT ?",
        (username, HISTORY_SHOWN))]
    unread = conn.execute("SELECT COUNT(*) FROM push_log WHERE username = ? AND id > ?", (username, seen)).fetchone()[0]
    return {"items": items, "seen": seen, "unread": unread}


@router.delete("/history/{item_id}")
def delete_history_item(item_id: int, conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    """Remove one notification from this user's list (other users keep theirs)."""
    conn.execute("DELETE FROM push_log WHERE id = ? AND username = ?", (item_id, username))
    # Commit before answering: db_dep's own commit runs after the response has gone out, and the app reloads
    # the list straight away — it must not get the deleted entry back.
    conn.commit()
    return {"ok": True}


@router.delete("/history")
def clear_history(conn: sqlite3.Connection = Depends(db_dep), username: str = Depends(current_username)) -> dict:
    """Remove all of this user's notifications."""
    conn.execute("DELETE FROM push_log WHERE username = ?", (username,))
    conn.commit()  # before answering, see delete_history_item
    return {"ok": True}


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
