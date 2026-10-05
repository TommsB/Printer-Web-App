"""Create a user or reset a password directly in the database — for when no admin can log in.

Usage (from backend/):   python scripts/set_user.py <username> <password> [admin|standard]
In Docker:               docker compose exec printers python scripts/set_user.py <username> <password> admin

A new user gets the given role (default: standard). For an existing user the password is replaced, and the
role too if one is given. Normally users are managed in the app: Pārvaldība → Lietotāji.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.auth import ROLES, hash_password  # noqa: E402
from app.db import get_db, init_db  # noqa: E402

if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and sys.argv[3] not in ROLES):
    sys.exit(__doc__)
user, password = sys.argv[1], sys.argv[2]
role = sys.argv[3] if len(sys.argv) == 4 else None

init_db()
with get_db() as conn:
    if conn.execute("SELECT 1 FROM users WHERE username = ?", (user,)).fetchone():
        conn.execute("UPDATE users SET password_hash = ? WHERE username = ?", (hash_password(password), user))
        if role:
            conn.execute("UPDATE users SET role = ? WHERE username = ?", (role, user))
        print(f"Password replaced for {user}" + (f", role set to {role}" if role else ""))
    else:
        conn.execute("INSERT INTO users (username, password_hash, role, created_by) VALUES (?,?,?,'set_user.py')",
                     (user, hash_password(password), role or "standard"))
        print(f"Created {user} ({role or 'standard'})")
