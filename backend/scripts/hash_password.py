"""Usage: python scripts/hash_password.py <username> <password>
Writes/updates the user in ../auth_users.json.

That file is only the bootstrap: its users are imported as admins the first time the app starts with an empty
users table. Afterwards users are managed in the app (Pārvaldība → Lietotāji); to fix a login from the command
line use scripts/set_user.py, which writes to the database."""

import json
import sys
from pathlib import Path

import bcrypt

path = Path(__file__).resolve().parents[2] / "auth_users.json"
if len(sys.argv) != 3:
    sys.exit(__doc__)
user, pw = sys.argv[1], sys.argv[2]
data = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {"users": {}}
data["users"][user] = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
path.write_text(json.dumps(data, indent=2), encoding="utf-8")
print(f"Saved {user} to {path}")

