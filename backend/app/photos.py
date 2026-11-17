"""A printer's picture ("profile picture"), shown in place of the printer icon in Statuss.

The browser crops and shrinks the picture before uploading (a small square JPEG, see the printer editor), so
files stay a few dozen KB. Here it is only checked to really be a JPEG, PNG or WebP image (by its first bytes,
not by what the browser claims), kept on disk next to the database (data/printer-photos/) under a random name,
and that name is stored in printers.photo. A new picture gets a new name, so the browser may cache each one
for good: the app asks for /photo?v=<name>, and the address changes with the picture.
"""

import sqlite3
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .config import config
from .db import db_dep, get_db

router = APIRouter(prefix="/api/printers", tags=["photos"])

MAX_BYTES = 3 * 1024 * 1024
KINDS = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


def folder() -> Path:
    path = Path(config["db_path"]).parent / "printer-photos"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _kind(head: bytes) -> str | None:
    """The file's extension from its first bytes, or None if it isn't a JPEG, PNG or WebP image."""
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    return None


def remove(stored: str | None) -> None:
    if stored:
        (folder() / Path(stored).name).unlink(missing_ok=True)


def sweep() -> None:
    """At startup: drop picture files no printer points at (a crash between writing and recording one)."""
    with get_db() as conn:
        known = {r["photo"] for r in conn.execute("SELECT photo FROM printers WHERE photo IS NOT NULL")}
    for f in folder().iterdir():
        if f.is_file() and f.name not in known:
            f.unlink(missing_ok=True)


def _photo_of(conn: sqlite3.Connection, printer_id: int) -> str | None:
    row = conn.execute("SELECT photo FROM printers WHERE id = ?", (printer_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Printeris nav atrasts")
    return row["photo"]


@router.put("/{printer_id}/photo")
def upload(printer_id: int, file: UploadFile, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    """Set (or replace) the printer's picture."""
    old = _photo_of(conn, printer_id)
    data = file.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"Attēls ir par lielu (līdz {MAX_BYTES // 1024 // 1024} MB)")
    ext = _kind(data[:12])
    if not ext:
        raise HTTPException(415, "Tas nav attēls (der JPEG, PNG vai WebP)")
    stored = uuid.uuid4().hex + ext
    (folder() / stored).write_bytes(data)
    try:
        conn.execute("UPDATE printers SET photo = ? WHERE id = ?", (stored, printer_id))
    except Exception:
        remove(stored)
        raise
    remove(old)
    return {"photo": stored}


@router.get("/{printer_id}/photo")
def download(printer_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> FileResponse:
    stored = _photo_of(conn, printer_id)
    path = folder() / Path(stored).name if stored else None
    if not path or not path.is_file():
        raise HTTPException(404, "Printerim nav attēla")
    # The address carries the file name (?v=…), so this exact picture never changes: cache it for good.
    return FileResponse(path, media_type=KINDS.get(path.suffix, "application/octet-stream"),
                        headers={"Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})


@router.delete("/{printer_id}/photo")
def delete(printer_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    old = _photo_of(conn, printer_id)
    conn.execute("UPDATE printers SET photo = NULL WHERE id = ?", (printer_id,))
    remove(old)
    return {"photo": None}
