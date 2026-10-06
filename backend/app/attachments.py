"""Files kept with orders.

Two kinds:
  - photos / documents of a defect (table `order_files`, one record each) — suppliers usually ask for a print
    sample or a picture of the cartridge;
  - delivery notes ("pavadzīmes") and other documents that come with a delivery (`delivery_docs`). One note
    covers all of a company's cartridges in that delivery, so a document is linked to several orders
    (`delivery_doc_orders`) and shows on each of them.

The files are kept on disk next to the database (data/attachments/), under a random name; the tables hold what
the user called them. They are only served to logged-in users, and only pictures and PDFs are shown in the
browser — everything else is offered as a download, so an uploaded file can never run as a page of this app.
"""

import sqlite3
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .auth import current_username
from .config import config
from .db import db_dep, get_db

router = APIRouter(prefix="/api", tags=["attachments"])

MAX_BYTES = 20 * 1024 * 1024
MAX_PER_ORDER = 20
INLINE = {"image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"}  # safe to open in the browser


def folder() -> Path:
    path = Path(config["db_path"]).parent / "attachments"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _save(files: list[UploadFile]) -> list[dict]:
    """Write the uploaded files to disk: [{name, mime, size, stored}]. All or nothing — if one is refused,
    none of them is kept. The caller records them (and calls `discard` if that fails)."""
    saved: list[dict] = []
    try:
        for f in files:
            name = Path(f.filename or "fails").name[:150] or "fails"
            stored = uuid.uuid4().hex + Path(name).suffix.lower()[:10]
            saved.append({"name": name, "mime": (f.content_type or "").lower()[:100], "size": 0, "stored": stored})
            with open(folder() / stored, "wb") as out:
                while chunk := f.file.read(1024 * 1024):
                    saved[-1]["size"] += len(chunk)
                    if saved[-1]["size"] > MAX_BYTES:
                        raise HTTPException(413, f"„{name}” ir par lielu (līdz {MAX_BYTES // 1024 // 1024} MB)")
                    out.write(chunk)
            if saved[-1]["size"] == 0:
                raise HTTPException(400, f"„{name}” ir tukšs")
    except Exception:
        discard(saved)
        raise
    return saved


def discard(saved: list[dict]) -> None:
    for s in saved:
        (folder() / s["stored"]).unlink(missing_ok=True)


def _serve(row: sqlite3.Row | None) -> FileResponse:
    path = folder() / row["stored"] if row else None
    if not path or not path.is_file():
        raise HTTPException(404, "Fails nav atrasts")
    inline = row["mime"] in INLINE
    return FileResponse(
        path, media_type=row["mime"] if inline else "application/octet-stream", filename=row["name"],
        content_disposition_type="inline" if inline else "attachment",
        headers={"X-Content-Type-Options": "nosniff"})


def sweep() -> None:
    """At startup: drop documents no order points at any more, and files on disk that nothing records (their
    order went with a deleted printer or toner)."""
    with get_db() as conn:
        conn.execute("DELETE FROM delivery_docs WHERE id NOT IN (SELECT doc_id FROM delivery_doc_orders)")
        known = {r["stored"] for r in conn.execute("SELECT stored FROM order_files UNION SELECT stored FROM delivery_docs")}
    for f in folder().iterdir():
        if f.is_file() and f.name not in known:
            f.unlink(missing_ok=True)


def remove_for_order(conn: sqlite3.Connection, order_id: int) -> None:
    """Before an order is deleted: its defect files go from disk (the rows go with the order), and so does any
    delivery document that was linked to this order only."""
    for r in conn.execute("SELECT stored FROM order_files WHERE order_id = ?", (order_id,)).fetchall():
        (folder() / r["stored"]).unlink(missing_ok=True)
    alone = conn.execute(
        "SELECT d.id, d.stored FROM delivery_docs d JOIN delivery_doc_orders l ON l.doc_id = d.id WHERE l.order_id = ?"
        " AND NOT EXISTS (SELECT 1 FROM delivery_doc_orders o WHERE o.doc_id = d.id AND o.order_id != ?)",
        (order_id, order_id)).fetchall()
    for r in alone:
        conn.execute("DELETE FROM delivery_docs WHERE id = ?", (r["id"],))
        (folder() / r["stored"]).unlink(missing_ok=True)


# ---- defect files (one record) ----------------------------------------------------------------

def _rows(conn: sqlite3.Connection, order_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT id, order_id, name, mime, size, uploaded_by, ts FROM order_files WHERE order_id = ? ORDER BY id", (order_id,))]


@router.get("/orders/{order_id}/files")
def list_files(order_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> list[dict]:
    return _rows(conn, order_id)


@router.post("/orders/{order_id}/files", status_code=201)
def upload(order_id: int, files: list[UploadFile], conn: sqlite3.Connection = Depends(db_dep),
           username: str = Depends(current_username)) -> list[dict]:
    """Attach one or more files to a defect."""
    if not conn.execute("SELECT 1 FROM orders WHERE id = ?", (order_id,)).fetchone():
        raise HTTPException(404, "Ieraksts nav atrasts")
    have = conn.execute("SELECT COUNT(*) FROM order_files WHERE order_id = ?", (order_id,)).fetchone()[0]
    if have + len(files) > MAX_PER_ORDER:
        raise HTTPException(400, f"Vienam ierakstam var pievienot līdz {MAX_PER_ORDER} failiem")
    saved = _save(files)
    try:
        conn.executemany("INSERT INTO order_files (order_id, name, mime, size, stored, uploaded_by) VALUES (?,?,?,?,?,?)",
                         [(order_id, s["name"], s["mime"], s["size"], s["stored"], username) for s in saved])
    except Exception:
        discard(saved)
        raise
    return _rows(conn, order_id)


@router.get("/order-files/{file_id}")
def download(file_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> FileResponse:
    return _serve(conn.execute("SELECT name, mime, stored FROM order_files WHERE id = ?", (file_id,)).fetchone())


@router.delete("/order-files/{file_id}")
def delete_file(file_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    row = conn.execute("SELECT stored FROM order_files WHERE id = ?", (file_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Fails nav atrasts")
    conn.execute("DELETE FROM order_files WHERE id = ?", (file_id,))
    (folder() / row["stored"]).unlink(missing_ok=True)
    return {"deleted": file_id}


# ---- delivery documents (shared by several orders) ----------------------------------------------

def docs_by_order(conn: sqlite3.Connection, order_ids: list[int] | None = None) -> dict[int, list[dict]]:
    """{order id: its delivery documents}, for all orders or just the given ones."""
    where, args = "", ()
    if order_ids is not None:
        where, args = f" WHERE l.order_id IN ({','.join('?' * len(order_ids))})", tuple(order_ids)
    out: dict[int, list[dict]] = {}
    for r in conn.execute(
            "SELECT l.order_id, d.id, d.name, d.mime, d.size, d.uploaded_by, d.ts FROM delivery_doc_orders l"
            f" JOIN delivery_docs d ON d.id = l.doc_id{where} ORDER BY d.id", args):
        d = dict(r)
        out.setdefault(d.pop("order_id"), []).append(d)
    return out


@router.post("/delivery-docs", status_code=201)
def upload_docs(files: list[UploadFile], order_ids: str = Form(...), conn: sqlite3.Connection = Depends(db_dep),
                username: str = Depends(current_username)) -> list[dict]:
    """Attach documents to a group of orders (`order_ids`: comma-separated). Each document shows on all of them."""
    try:
        ids = sorted({int(x) for x in order_ids.split(",") if x.strip()})
    except ValueError:
        raise HTTPException(400, "Nederīgs pasūtījumu saraksts")
    if not ids or len(ids) > 200 or len(files) > MAX_PER_ORDER:
        raise HTTPException(400, "Nederīgs pasūtījumu vai failu skaits")
    found = conn.execute(f"SELECT COUNT(*) FROM orders WHERE id IN ({','.join('?' * len(ids))})", ids).fetchone()[0]
    if found != len(ids):
        raise HTTPException(404, "Kāds no pasūtījumiem vairs neeksistē")
    saved = _save(files)
    try:
        out = []
        for s in saved:
            doc_id = conn.execute("INSERT INTO delivery_docs (name, mime, size, stored, uploaded_by) VALUES (?,?,?,?,?)",
                                  (s["name"], s["mime"], s["size"], s["stored"], username)).lastrowid
            conn.executemany("INSERT INTO delivery_doc_orders (doc_id, order_id) VALUES (?,?)", [(doc_id, i) for i in ids])
            out.append({"id": doc_id, "name": s["name"], "mime": s["mime"], "size": s["size"], "uploaded_by": username})
    except Exception:
        discard(saved)
        raise
    return out


@router.get("/delivery-docs/{doc_id}")
def download_doc(doc_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> FileResponse:
    return _serve(conn.execute("SELECT name, mime, stored FROM delivery_docs WHERE id = ?", (doc_id,)).fetchone())


@router.delete("/delivery-docs/{doc_id}")
def delete_doc(doc_id: int, conn: sqlite3.Connection = Depends(db_dep)) -> dict:
    """Removes the document from every order it was linked to."""
    row = conn.execute("SELECT stored FROM delivery_docs WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Dokuments nav atrasts")
    conn.execute("DELETE FROM delivery_docs WHERE id = ?", (doc_id,))
    (folder() / row["stored"]).unlink(missing_ok=True)
    return {"deleted": doc_id}
