import json
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = PROJECT_ROOT / "config.json"

DEFAULTS = {
    "db_path": str(PROJECT_ROOT / "data" / "printers.db"),
    "snmp_bin_dir": "",  # folder with snmpget.exe / snmpwalk.exe; empty = on PATH
    "snmp_community": "public",
    "poll_interval_minutes": 15,
    "snapshot_keep_days": 30,
    "frontend_dist": str(PROJECT_ROOT / "frontend" / "dist"),
    # Sign in with Microsoft (Entra ID) — see microsoft.py. Off until all four are set (env vars / .env).
    "entra_tenant_id": "",
    "entra_client_id": "",
    "entra_client_secret": "",
    "public_url": "",  # how users reach the app, e.g. https://printeri.tenax.lv (for the Microsoft redirect)
    # "true"/"false" as text (env vars are text): let any account of the tenant in as a standard user,
    # or only people already listed in Pārvaldība → Lietotāji.
    "entra_auto_create": "true",
    "password_login": "true",  # "false" = Microsoft only (the rescue script still works)
}


def flag(key: str) -> bool:
    """A "true"/"false" setting as a boolean."""
    return str(config[key]).strip().lower() in ("1", "true", "yes", "on")


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, encoding="utf-8-sig") as f:
            cfg.update(json.load(f))
    # Env vars (e.g. SNMP_BIN_DIR, SNMP_COMMUNITY) override the file, so the
    # Docker image can use the Linux net-snmp tools on PATH regardless of config.json.
    for key, default in DEFAULTS.items():
        env = os.environ.get(key.upper())
        if env is not None:
            cfg[key] = type(default)(env)
    return cfg


config = load_config()

