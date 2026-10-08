# PrinterWebApp

Printer registry, per-printer toner stock and live SNMP status. FastAPI + SQLite backend, React (Vite) frontend, shipped as one Docker image.

## Run with Docker (dev machine and the Linux VM)
```
docker compose up -d --build        # http://<host>:8000
docker compose logs -f
docker compose down                 # data survives (named volume printer-data)
```
- The image installs Linux Net-SNMP (`snmp` package); no .exe files are used. `SNMP_BIN_DIR` is forced empty in the image.
- Logins live in the database and are managed in the app: **Pārvaldība → Lietotāji** (administrators only).
  Two roles, `admin` and `standard`: same rights in the app, only an admin can manage users.
  - First start: the users in `auth_users.json` (next to `docker-compose.yml`, mounted read-only) are imported
    once as admins. After that the file is no longer read. Create that first entry with
    `docker compose run --rm --no-deps -v ${PWD}/auth_users.json:/app/auth_users.json printers python scripts/hash_password.py <user> <pass>`.
  - Locked out (no admin can log in): `docker compose exec printers python scripts/set_user.py <user> <pass> admin`
    creates the user or resets the password directly in the database.
- Settings via env vars in `docker-compose.yml`: `SNMP_COMMUNITY`, `POLL_INTERVAL_MINUTES`, `SNAPSHOT_KEEP_DAYS`.
- The container must be able to route to the printer subnets (192.168.88/90/91.x, 10.0.2.x).

### Sign in with Microsoft (Entra ID)
Off by default; the password login keeps working either way. It needs the app's final **https** address.

**1. App registration** (Entra admin center → App registrations → New registration; needs a tenant admin):
- Name: e.g. `Printeru pārvaldība`. Supported account types: **this organizational directory only** (single tenant).
- Redirect URI: platform **Web**, `https://<app-address>/api/auth/microsoft/callback`
  (for a test on a dev PC also add `http://localhost:8000/api/auth/microsoft/callback`).
- Certificates & secrets → New client secret → copy the secret **Value** (shown once; note its expiry date).
- API permissions: the default delegated `User.Read` is enough (the app only asks for `openid profile email`).
  "Grant admin consent" saves users the consent prompt.
- Optional, to limit who can sign in: Enterprise applications → this app → Properties →
  "Assignment required" = Yes, then assign the people or a group.
- Hand over three values: **Directory (tenant) ID**, **Application (client) ID**, the **secret Value**.

**2. On the server**, in the `.env` file next to `docker-compose.yml` (not in git):
```
ENTRA_TENANT_ID=<tenant id>
ENTRA_CLIENT_ID=<client id>
ENTRA_CLIENT_SECRET=<secret value>
PUBLIC_URL=https://<app-address>
```
then `docker compose up -d`. The login page now shows "Pieslēgties ar Microsoft".

**Who gets in.** Once Microsoft sign-in is configured, the policy is strict by default:
- **Only people listed in Pārvaldība → Lietotāji**, and they must sign in with an account of this tenant.
  A Microsoft account is matched to an app user by its sign-in name: the full name (`janis.berzins@tenax.lv`)
  or the part before the `@` (`janis.berzins`) — so existing logins keep their role and settings.
  To give someone access, an administrator adds them there (username = the part before the `@`, no password).
  Anyone else is refused ("nav piekļuves šai lietotnei").
- **Only through Microsoft**: the username + password form is gone.

Two switches in `.env` loosen this:
- `PASSWORD_LOGIN=true` — also allow username + password. **Use it for the first test**, and as the way back in
  if Microsoft sign-in is misconfigured: set it, `docker compose up -d`, log in with a password
  (`set_user.py` can create or reset one).
- `ENTRA_AUTO_CREATE=true` — any account of the tenant gets in, added as a standard user on first sign-in.

### Push notifications
Each user turns them on per device in the profile window (round button, top right) → **Paziņojumi**, and picks
the kinds: a printer can't print / stopped answering, a toner replacement to confirm, a toner nearly empty with
no spare. They are sent after each SNMP poll, once per problem (`backend/app/push.py`).
- Needs the app on **https**, and `PUBLIC_URL=https://<app-address>` in `.env` (it identifies this server to
  the push services).
- The server needs outbound internet to the push services (Apple `*.push.apple.com`, Google
  `fcm.googleapis.com`, Mozilla `updates.push.services.mozilla.com`).
- iPhone/iPad: only in the home-screen app (Safari → Share → Add to Home Screen), iOS 16.4 or newer.
- **Notification hours** (same window → **Paziņojumu laiks**): each user can limit notifications to a time of
  day (from–to, may run past midnight) and weekdays. Outside those hours nothing is sent or added to their
  bell list. What came up meanwhile waits and is delivered at the first poll inside their hours, with the time
  it started — unless the problem is over by then (a printer off for the night and back in the morning stays
  silent). Times are the server's local time (`TZ` in the Dockerfile).
- **Bell list**: per user. × removes one entry, "Notīrīt visus" all of them; other users keep theirs. It holds
  each user's last 300 notifications.
- The server's key pair is created on first use and lives in the database (`app_kv`). Restoring an older
  database copy, or starting with a new one, means every device has to switch notifications on again.

### Toners, drums and other consumables
The catalogue (Pārvaldība → Toneri) has three kinds; all of them can be linked to a printer with a norm, kept
in the reserve, ordered and received the same way.
- **Toneris** and **Drums** are tied to what the printer reports over SNMP: the level is shown in the printer
  view, a replacement is detected (Vēsture → Jāpārbauda; confirming takes 1 from that item's reserve), and a
  "zems pēdējais toneris / drums" notification is sent when it is low (toner < 40%, drum < 15%, or forecast to
  run out within two weeks) with no spare in the reserve.
- **Cits** (waste box, fuser…): reserve and orders only; its level and replacement are not tracked.
- A supply is matched to a linked item by **kind and colour** (`replacements.py: classify, pick`; the same
  rules are in `frontend/src/lib.ts`), so a black drum is never taken for the black toner. Give drums their
  colour; a drum code used for several colours gets no colour ("–") and then stands for every drum colour that
  has no item of its own.

### Database
SQLite at `/app/data/printers.db` inside the `printer-data` volume (a named volume, because SQLite WAL breaks on Windows bind mounts).
```
docker compose exec printers python -c "import sqlite3;print(sqlite3.connect('/app/data/printers.db').execute('select count(*) from printers').fetchone())"
docker compose cp printers:/app/data/printers.db ./printers-backup.db     # backup / open in DB Browser for SQLite
docker compose cp ./printers.db printers:/app/data/printers.db            # restore (stop the container first)
```
Seed from Excel (empty DB): `docker compose cp file.xlsx printers:/tmp/f.xlsx; docker compose exec printers python scripts/import_excel.py /tmp/f.xlsx`

## Develop without Docker (Windows)
```
backend:  .venv\Scripts\python -m uvicorn app.main:app --reload --port 8000    # uses config.json (snmp_bin_dir = .exe folder)
frontend: npm run dev        # http://localhost:5173, /api proxied to :8000
```
After frontend changes for the Docker image just re-run `docker compose up -d --build`.

UI: warm-grey 'sheet' design (see the Design canvas). Status page is master/detail (list slides left, detail on the right; on phones the detail is its own view with a back button). Toner colours come from SNMP supply names (frontend/src/lib.ts).
