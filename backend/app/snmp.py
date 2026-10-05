"""SNMP polling via the Net-SNMP command-line tools (snmpget/snmpwalk).

Same OIDs and parsing as the original printer_snmp_to_csv.py script.
"""

import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from .config import config

OID_SYSNAME = "1.3.6.1.2.1.1.5.0"
OID_UPTIME = "1.3.6.1.2.1.1.3.0"  # hundredths of a second
OID_SERIAL = "1.3.6.1.2.1.43.5.1.1.17.1"
OID_DEVICE_STATUS = "1.3.6.1.2.1.25.3.5.1.1.1"
OID_PAGECOUNT = "1.3.6.1.2.1.43.10.2.1.4.1.1"
OID_SUPPLY_DESC = "1.3.6.1.2.1.43.11.1.1.6.1"
OID_SUPPLY_LEVEL = "1.3.6.1.2.1.43.11.1.1.9.1"
OID_SUPPLY_MAX = "1.3.6.1.2.1.43.11.1.1.8.1"
OID_ALERT_DESC = "1.3.6.1.2.1.43.18.1.1.8.1"

DEVICE_STATUS_MAP = {"1": "other", "2": "unknown", "3": "idle", "4": "printing", "5": "warmup"}
# The type prefix is optional: printers with an empty sysName answer `= ""` with no type.
LINE_RE = re.compile(r"^\.?([\d.]+)\s*=\s*(?:\w+:\s*)?(.*)$")
_NO_VALUE = ("No Such Object", "No Such Instance", "No more variables")


def _bin(name: str) -> str:
    # Empty snmp_bin_dir = Net-SNMP tools on PATH (Linux/Docker: `apt install snmp`).
    d = config["snmp_bin_dir"]
    if not d:
        return name
    return os.path.join(d, name + (".exe" if os.name == "nt" else ""))


def _run(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=40).stdout
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return ""


def _base(ip: str) -> list[str]:
    return ["-v2c", "-c", config["snmp_community"], "-r", "1", "-t", "2", "-On", "-Oa", "-Le", ip]


def snmp_get(ip: str, oid: str) -> str | None:
    out = _run([_bin("snmpget"), *_base(ip), oid]).strip()
    m = LINE_RE.match(out.splitlines()[-1].strip()) if out else None
    if not m or m.group(2).startswith(_NO_VALUE):
        return None
    return m.group(2).strip('"')


def snmp_walk_table(ip: str, base_oid: str) -> dict[str, str]:
    out = _run([_bin("snmpwalk"), *_base(ip), base_oid])
    result: dict[str, str] = {}
    for line in out.strip().splitlines():
        m = LINE_RE.match(line.strip())
        if not m:
            continue
        oid, value = m.group(1), m.group(2).strip('"')
        if oid.startswith(base_oid + ".") and not value.startswith(_NO_VALUE):
            result[oid[len(base_oid) + 1:]] = value
    return result


def _to_int(v: str | None) -> int | None:
    m = re.search(r"-?\d+", v or "")
    return int(m.group()) if m else None


OID_ALERT_SEVERITY = "1.3.6.1.2.1.43.18.1.1.2.1"  # prtAlertSeverityLevel: 3 = critical (printer can't print)
OID_HR_DEVICE_STATUS = "1.3.6.1.2.1.25.3.2.1.5.1"  # hrDeviceStatus: 2 running, 3 warning, 5 down
OID_ERROR_STATE = "1.3.6.1.2.1.25.3.5.1.2.1"  # hrPrinterDetectedErrorState: bit flags (RFC 3805)

# hrPrinterDetectedErrorState flags that stop printing → shown reason. (Low paper/toner, service requested,
# overdue maintenance and "output nearly full" are only warnings: the printer still prints.)
BLOCKING_FLAGS = [
    (0, 0x04, "Iestrēdzis papīrs"),
    (0, 0x08, "Atvērtas durtiņas"),
    (0, 0x40, "Nav papīra"),
    (0, 0x10, "Nav tonera"),
    (1, 0x20, "Trūkst tonera kasetnes"),
    (1, 0x80, "Trūkst papīra paplātes"),
    (1, 0x40, "Trūkst izvades paplātes"),
    (1, 0x08, "Izvades paplāte pilna"),
    (0, 0x02, "Printeris bezsaistē"),
]


# Still prints, but someone should look soon ("needs attention" dot in the list): maintenance.
# Toner warnings are deliberately left out — toner levels are shown on their own.
# Only overduePreventMaint. Not serviceRequested (byte 0, 0x01): the Konicas set it whenever they are in
# power-save ("Low Power"), so it lit up sleeping printers that need nothing.
MAINT_FLAGS = [(1, 0x02)]
MAINT_ALERT = re.compile(r"mainten|service|end of life|life end|replace|kit", re.I)
TONER_ALERT = re.compile(r"toner|cartridge|ink", re.I)


def attention_reasons(flags: bytes, alert_descs: dict[str, str]) -> list[str]:
    """Why the printer needs attention although it prints: maintenance flags / maintenance-type alerts."""
    reasons: list[str] = []
    if any(len(flags) > byte and flags[byte] & bit for byte, bit in MAINT_FLAGS):
        reasons.append("Nepieciešama apkope")
    for text in alert_descs.values():
        t = text.strip()
        if t and MAINT_ALERT.search(t) and not TONER_ALERT.search(t):
            reasons.append("Nepieciešama apkope" if re.search(r"mainten|service", t, re.I) else t)
    return list(dict.fromkeys(reasons))


def _hex_bytes(ip: str, oid: str) -> bytes:
    """An OCTET STRING as raw bytes (-Ox: always hex, even when the bytes happen to be printable)."""
    out = _run([_bin("snmpget"), *_base(ip), "-Ox", oid]).strip()
    m = LINE_RE.match(out.splitlines()[-1].strip()) if out else None
    if not m:
        return b""
    hexes = re.findall(r"\b[0-9A-Fa-f]{2}\b", m.group(2).split(":", 1)[-1])
    return bytes(int(h, 16) for h in hexes)


def blocking_reasons(ip: str, alert_descs: dict[str, str], flags: bytes) -> list[str]:
    """Why the printer can't print right now (empty = it can): critical alerts, error flags, device 'down'."""
    reasons: list[str] = []
    for idx, sev in snmp_walk_table(ip, OID_ALERT_SEVERITY).items():
        if _to_int(sev) == 3:  # critical
            reasons.append(alert_descs.get(idx, "").strip() or "Kritiska kļūda")
    for byte, bit, text in BLOCKING_FLAGS:
        if len(flags) > byte and flags[byte] & bit:
            reasons.append(text)
    if not reasons and _to_int(snmp_get(ip, OID_HR_DEVICE_STATUS)) == 5:
        reasons.append("Printeris ziņo, ka nedarbojas")
    return list(dict.fromkeys(reasons))  # no duplicates, keep order


@dataclass
class PollResult:
    reachable: bool = False
    hostname: str = ""
    serial: str = ""
    status: str = ""
    uptime_hours: float | None = None
    page_count: int | None = None
    alerts: str = ""
    blocking: str = ""  # reasons the printer can't print, " | "-joined; empty = it can
    attention: str = ""  # still prints, but needs looking at (maintenance), " | "-joined
    supplies: list[dict] = field(default_factory=list)


def poll_printer(ip: str) -> PollResult:
    # sysUpTime is mandatory on every SNMP agent (sysName may legitimately be empty),
    # so no answer to it means the printer is offline.
    ticks = _to_int(snmp_get(ip, OID_UPTIME))
    if ticks is None:
        return PollResult(reachable=False)

    res = PollResult(reachable=True, hostname=snmp_get(ip, OID_SYSNAME) or "")
    res.serial = snmp_get(ip, OID_SERIAL) or ""
    res.page_count = _to_int(snmp_get(ip, OID_PAGECOUNT))
    res.uptime_hours = round(ticks / 100 / 3600, 1)
    raw_status = (snmp_get(ip, OID_DEVICE_STATUS) or "").strip()
    res.status = DEVICE_STATUS_MAP.get(raw_status, raw_status)
    alert_descs = snmp_walk_table(ip, OID_ALERT_DESC)
    res.alerts = " | ".join(alert_descs.values())
    flags = _hex_bytes(ip, OID_ERROR_STATE)
    blocking = blocking_reasons(ip, alert_descs, flags)  # alert tables are keyed by alert index
    res.blocking = " | ".join(blocking)
    res.attention = "" if blocking else " | ".join(attention_reasons(flags, alert_descs))

    descs = snmp_walk_table(ip, OID_SUPPLY_DESC)
    levels = snmp_walk_table(ip, OID_SUPPLY_LEVEL)
    maxes = snmp_walk_table(ip, OID_SUPPLY_MAX)
    for idx, desc in descs.items():
        level, mx = _to_int(levels.get(idx)), _to_int(maxes.get(idx))
        # Printer-MIB: level -1 = unrestricted, -2 = unknown, -3 = some remaining.
        pct = None
        if level is not None and mx and mx > 0 and level >= 0:
            pct = max(0, min(100, round(level * 100 / mx)))
        res.supplies.append({
            "idx": idx, "description": desc, "level": level,
            "max_capacity": mx, "pct": pct,
        })
    return res


OID_SYSDESCR = "1.3.6.1.2.1.1.1.0"


def test_printer(ip: str) -> dict:
    """One-off check for the printer editor: does this IP answer SNMP, and what does it report? Nothing is saved."""
    res = poll_printer(ip)
    if not res.reachable:
        return {"reachable": False}
    return {
        "reachable": True,
        "hostname": res.hostname,
        "description": (snmp_get(ip, OID_SYSDESCR) or "").strip(),
        "serial": res.serial,
        "page_count": res.page_count,
        "supplies": [{"description": s["description"], "pct": s["pct"]} for s in res.supplies],
    }


def poll_many(printers: list[tuple[int, str]]) -> dict[int, PollResult]:
    """Poll [(printer_id, ip)] concurrently so offline printers don't block the rest."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pid: pool.submit(poll_printer, ip) for pid, ip in printers}
        return {pid: f.result() for pid, f in futures.items()}
