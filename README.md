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
