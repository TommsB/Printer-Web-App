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
}


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

