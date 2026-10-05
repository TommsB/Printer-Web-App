import asyncio
import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import auth, microsoft, orders, printers, replacements, settings, toners
from .auth import current_username
from .config import config
from .db import init_db
from .poller import poll_loop


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    auth.bootstrap_users()  # first start: logins from auth_users.json become the first admins
    task = asyncio.create_task(poll_loop())
    yield
    task.cancel()


app = FastAPI(title="Printer Manager", lifespan=lifespan)

require_auth = Depends(current_username)
app.include_router(auth.router)
app.include_router(microsoft.router)  # Sign in with Microsoft (off until ENTRA_* and PUBLIC_URL are set)
app.include_router(auth.users_router, dependencies=[Depends(auth.require_admin)])  # every route: admins only
app.include_router(printers.router, dependencies=[require_auth])
app.include_router(toners.router, dependencies=[require_auth])
app.include_router(orders.router, dependencies=[require_auth])
app.include_router(replacements.router, dependencies=[require_auth])
app.include_router(settings.router, dependencies=[require_auth])


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.middleware("http")
async def cache_headers(request, call_next):
    """Phones (esp. the iPhone home-screen app) must never keep an old app version:
    - /assets/* have content hashes in their names -> cache forever;
    - the page itself, manifest, icons -> always revalidate (cheap 304 via ETag), so a new build shows up;
    - /api/* -> never cache data."""
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    else:
        response.headers["Cache-Control"] = "no-cache"
    return response


# Serve the built frontend (single port for the LAN). In dev, Vite runs separately
# and proxies /api here, so a missing dist folder is fine.
mimetypes.add_type("application/manifest+json", ".webmanifest")  # home-screen app manifest
_dist = Path(config["frontend_dist"])
if _dist.is_dir():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = _dist / path
        return FileResponse(f if path and f.is_file() else _dist / "index.html")
