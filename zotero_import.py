"""Import Zotero collections into MyLibrary, fully offline.

Reads metadata (title / authors / year / venue / DOI / URL) straight from the
Zotero SQLite database (opened read-only) and reuses the PDFs already sitting in
Zotero's storage folder. Nothing is downloaded, so paywalled papers you already
own still get their PDF and figure thumbnails.

Usage
-----
    python zotero_import.py --list                       # show collections
    python zotero_import.py --collection "Reading list"   # import one collection
    python zotero_import.py -c "Reading list" -c "Inbox" --tag imported
    python zotero_import.py -c "Inbox" --dry-run         # preview only

Zotero location
---------------
Defaults to ~/Zotero. Override with --zotero-dir, or with the environment
variables ZOTERO_DB_PATH / ZOTERO_STORAGE_PATH.

Close Zotero (or accept a read-only snapshot) before running: the database is
opened with `immutable=1`, so a running Zotero will not be disturbed, but very
recent edits may not be visible.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import re
import sqlite3
import sys
from pathlib import Path

from sqlalchemy import event

from mylibrary.config import Settings
from mylibrary.models import Paper, StoredFile
from mylibrary.schemas import AuthorData, PaperCandidate
from mylibrary.services.library import LibraryService

VENUE_FIELDS = ("publicationTitle", "proceedingsTitle", "conferenceName", "institution", "publisher")

# Zotero attachment link modes that keep the file inside Zotero's storage folder.
IMPORTED_LINK_MODES = (0, 1)  # imported_file, imported_url


# --------------------------------------------------------------------------- #
# Zotero database access
# --------------------------------------------------------------------------- #

def zotero_paths(zotero_dir: str | None) -> tuple[str, Path]:
    """Resolve (database path, storage directory) from flags, environment, defaults."""
    if zotero_dir:
        root = Path(zotero_dir).expanduser()
        return str(root / "zotero.sqlite"), root / "storage"
    database = os.environ.get("ZOTERO_DB_PATH")
    storage = os.environ.get("ZOTERO_STORAGE_PATH")
    root = Path.home() / "Zotero"
    return database or str(root / "zotero.sqlite"), Path(storage or root / "storage")


def open_zotero(database_path: str) -> sqlite3.Connection:
    if not Path(database_path).exists():
        raise SystemExit(
            f"Zotero database not found: {database_path}\n"
            "Pass --zotero-dir /path/to/Zotero or set ZOTERO_DB_PATH."
        )
    return sqlite3.connect(f"file://{database_path}?immutable=1", uri=True)


def list_collections(zot: sqlite3.Connection) -> list[tuple[str, int]]:
    """Collection names with their item counts, deepest-path first is not needed here."""
    rows = zot.execute(
        """SELECT c.collectionName, COUNT(ci.itemID)
           FROM collections c
           LEFT JOIN collectionItems ci ON ci.collectionID = c.collectionID
           GROUP BY c.collectionID
           ORDER BY c.collectionName COLLATE NOCASE"""
    ).fetchall()
    return [(name, count) for name, count in rows]


def collection_items(zot: sqlite3.Connection, name: str) -> list[int]:
    """Top-level item IDs in a collection: no attachments, notes, or trashed items."""
    rows = zot.execute(
        """SELECT DISTINCT ci.itemID
           FROM collections c
           JOIN collectionItems ci ON ci.collectionID = c.collectionID
           JOIN items i ON i.itemID = ci.itemID
           JOIN itemTypes it ON it.itemTypeID = i.itemTypeID
           WHERE c.collectionName = ?
             AND it.typeName NOT IN ('attachment', 'note', 'annotation')
             AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
           ORDER BY ci.orderIndex, ci.itemID""",
        (name,),
    ).fetchall()
    return [row[0] for row in rows]


def pdf_attachment_key(zot: sqlite3.Connection, item_id: int) -> str | None:
    """Storage key of the first PDF attached to a Zotero item, if it is a stored copy."""
    rows = zot.execute(
        """SELECT i.key, a.linkMode, a.contentType, a.path
           FROM itemAttachments a
           JOIN items i ON i.itemID = a.itemID
           WHERE a.parentItemID = ?
             AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
           ORDER BY a.itemID""",
        (item_id,),
    ).fetchall()
    for key, link_mode, content_type, path in rows:
        is_pdf = (content_type or "").lower() == "application/pdf" or (path or "").lower().endswith(".pdf")
        if is_pdf and link_mode in IMPORTED_LINK_MODES:
            return key
    return None


def zfield(zot: sqlite3.Connection, item_id: int, name: str) -> str | None:
    row = zot.execute(
        """SELECT idv.value FROM itemData d
           JOIN fieldsCombined f ON d.fieldID = f.fieldID
           JOIN itemDataValues idv ON d.valueID = idv.valueID
           WHERE d.itemID = ? AND f.fieldName = ?""",
        (item_id, name),
    ).fetchone()
    return row[0] if row else None


def zauthors(zot: sqlite3.Connection, item_id: int) -> list[AuthorData]:
    rows = zot.execute(
        """SELECT c.firstName, c.lastName FROM itemCreators ic
           JOIN creators c ON ic.creatorID = c.creatorID
           JOIN creatorTypes ct ON ic.creatorTypeID = ct.creatorTypeID
           WHERE ic.itemID = ? AND ct.creatorType = 'author'
           ORDER BY ic.orderIndex""",
        (item_id,),
    ).fetchall()
    authors = []
    for first, last in rows:
        first = (first or "").strip()
        last = (last or "").strip()
        name = " ".join(part for part in (first, last) if part) or last or first
        if name:
            authors.append(AuthorData(name=name, given_name=first or None, family_name=last or None))
    return authors


def zyear(date_str: str | None) -> int | None:
    if not date_str:
        return None
    match = re.search(r"\b(18|19|20|21)\d{2}\b", date_str)
    return int(match.group()) if match else None


def build_candidate(zot: sqlite3.Connection, item_id: int) -> tuple[PaperCandidate, str | None]:
    title = (zfield(zot, item_id, "title") or "").strip()
    doi = (zfield(zot, item_id, "DOI") or "").strip() or None
    year = zyear(zfield(zot, item_id, "date"))
    venue = next((zfield(zot, item_id, field) for field in VENUE_FIELDS if zfield(zot, item_id, field)), None)
    url = (zfield(zot, item_id, "url") or "").strip() or None

    arxiv_id = None
    if doi and "10.48550/arxiv." in doi.lower():
        arxiv_id = doi.split("arXiv.", 1)[-1] if "arXiv." in doi else doi.lower().split("10.48550/arxiv.", 1)[-1]
    if not arxiv_id and url:
        match = re.search(r"arxiv\.org/(?:abs|pdf)/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?$", url)
        if match:
            arxiv_id = match.group(1)

    identifiers = {}
    if doi:
        identifiers["doi"] = doi
    if arxiv_id:
        identifiers["arxiv"] = arxiv_id

    candidate = PaperCandidate(
        title=title, source="zotero", authors=zauthors(zot, item_id), year=year,
        venue=venue, doi=doi, arxiv_id=arxiv_id, canonical_url=url,
        identifiers=identifiers, pdf_urls=[], raw={"zotero_item_id": item_id},
    )
    return candidate, url


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #

def find_pdf(storage_dir: Path, key: str) -> Path | None:
    pdfs = sorted((storage_dir / key).glob("*.pdf"))
    return pdfs[0] if pdfs else None


async def attach_local_pdf(
    service: LibraryService,
    paper_id: str,
    pdf_path: Path,
    arxiv_id: str | None,
    source_url: str | None,
) -> str:
    """Copy a Zotero PDF into the content-addressed store and build figure thumbnails."""
    data = pdf_path.read_bytes()
    if data[:5] != b"%PDF-":
        return "SKIP(not-a-pdf)"
    sha = hashlib.sha256(data).hexdigest()
    relative = f"files/{sha[:2]}/{sha}.pdf"
    destination = service.settings.managed_path(relative)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        destination.write_bytes(data)
    thumbnails = await service.files.create_thumbnails(relative, sha, arxiv_id=arxiv_id, source_url=source_url)
    with service.sessions.begin() as session:
        paper = session.get(Paper, paper_id)
        if not any(stored.sha256 == sha for stored in paper.files):
            paper.files.append(StoredFile(
                relative_path=relative, sha256=sha, size_bytes=len(data),
                source_url=source_url or f"zotero-local:{pdf_path.name}",
                mime_type="application/pdf", is_primary=not paper.files,
            ))
    figures = sum(1 for name in thumbnails if name.startswith("figure"))
    return f"pdf+{figures}fig"


async def import_collections(
    collections: list[str],
    *,
    database_path: str,
    storage_dir: Path,
    data_dir: str | None,
    tags: list[str],
    dry_run: bool,
) -> int:
    zot = open_zotero(database_path)
    service = None
    if not dry_run:
        service = LibraryService(Settings.create(data_dir))
        service.settings.initialize()

        @event.listens_for(service.engine, "connect")
        def _busy(dbapi_connection, _record):  # type: ignore[no-untyped-def]
            dbapi_connection.execute("PRAGMA busy_timeout=15000")

        service.engine.dispose()  # force new connections to pick up busy_timeout

    total = imported = with_pdf = 0
    for collection in collections:
        item_ids = collection_items(zot, collection)
        if not item_ids:
            print(f"! collection {collection!r} is empty or does not exist", file=sys.stderr)
            continue
        print(f"\n# {collection} — {len(item_ids)} item(s)")
        print(f"{'new':>5}  {'paper_id':8}  {'status':12}  title")
        print("-" * 82)
        for item_id in item_ids:
            total += 1
            try:
                candidate, url = build_candidate(zot, item_id)
                if not candidate.title:
                    print(f"{'ERR':>5}  {'-':8}  {'NO-TITLE':12}  zotero item {item_id}")
                    continue
                if dry_run:
                    key = pdf_attachment_key(zot, item_id)
                    has_pdf = bool(key and find_pdf(storage_dir, key))
                    print(f"{'-':>5}  {'-':8}  {'DRY-RUN':12}  {candidate.title[:44]}"
                          f"{'' if has_pdf else '  (no local PDF)'}")
                    continue
                result = await service.add_candidate(candidate, download_pdf=False)
                key = pdf_attachment_key(zot, item_id)
                pdf_path = find_pdf(storage_dir, key) if key else None
                if pdf_path is None:
                    status = "NO-PDF-FILE"
                else:
                    status = await attach_local_pdf(service, result.paper_id, pdf_path, candidate.arxiv_id, url)
                    if status.startswith("pdf"):
                        with_pdf += 1
                for tag in tags or [collection]:
                    service.add_tag(result.paper_id, tag)
                imported += 1
                print(f"{str(result.created):>5}  {result.paper_id[:8]}  {status:12}  {candidate.title[:44]}")
            except Exception as error:  # noqa: BLE001 - report and continue
                print(f"{'ERR':>5}  {'-':8}  {'ERROR':12}  {type(error).__name__}: {error}")
    zot.close()
    print("-" * 82)
    print(f"done: {imported}/{total} item(s) imported, {with_pdf} with local PDF + figures")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-c", "--collection", action="append", default=[],
                        help="Zotero collection name (repeatable)")
    parser.add_argument("--list", action="store_true", help="list collections and exit")
    parser.add_argument("--zotero-dir", help="Zotero data directory (default: ~/Zotero)")
    parser.add_argument("--data-dir", help="MyLibrary data directory (default: ./data)")
    parser.add_argument("--tag", action="append", default=[],
                        help="tag to apply (repeatable; defaults to the collection name)")
    parser.add_argument("--dry-run", action="store_true", help="show what would be imported")
    args = parser.parse_args()

    database_path, storage_dir = zotero_paths(args.zotero_dir)

    if args.list:
        zot = open_zotero(database_path)
        for name, count in list_collections(zot):
            print(f"{count:>5}  {name}")
        zot.close()
        return 0

    if not args.collection:
        parser.error("pass at least one --collection, or --list to see what is available")

    return asyncio.run(import_collections(
        args.collection,
        database_path=database_path,
        storage_dir=storage_dir,
        data_dir=args.data_dir,
        tags=args.tag,
        dry_run=args.dry_run,
    ))


if __name__ == "__main__":
    raise SystemExit(main())
