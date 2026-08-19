# Importing from Zotero

`zotero_import.py` bulk-imports one or more Zotero collections into MyLibrary,
entirely offline. It reads metadata straight out of Zotero's own SQLite database and
reuses PDFs already sitting in Zotero's storage folder — nothing is downloaded, so
paywalled papers you already own in Zotero keep their PDF and get figure thumbnails
too.

It is a standalone script at the repo root, not a `mylibrary` subcommand. Run it from
an environment where the `mylibrary` package is importable (the project's venv):

```bash
.venv/bin/python zotero_import.py --list
```

## What it reads from Zotero

For each top-level item in a collection (attachments, notes, and Zotero's own
"annotation" item type are excluded, as are trashed items), it reads directly from
Zotero's `zotero.sqlite`:

- **Title** — the `title` field.
- **Authors** — `itemCreators` rows whose creator type is `author`, in Zotero's
  stored order.
- **Year** — the first 4-digit year found in the `date` field.
- **Venue** — the first non-empty value among `publicationTitle`,
  `proceedingsTitle`, `conferenceName`, `institution`, `publisher`.
- **DOI** and **URL** — the `DOI` and `url` fields.
- **arXiv ID** — parsed out of an arXiv-style DOI (`10.48550/arXiv....`) or, failing
  that, out of an `arxiv.org/abs/...` or `.../pdf/...` URL.
- **PDF attachment** — the first child attachment whose content type or file
  extension is PDF *and* whose Zotero link mode is `imported_file` or
  `imported_url` (i.e. Zotero holds its own copy). Linked-file attachments that only
  point at a path outside Zotero's storage are not used.

This is intentionally a small slice of Zotero's schema — no collections hierarchy,
no notes, no attachments beyond the one PDF, no tags from Zotero itself (see
`--tag` below).

## Zotero is never written to

`open_zotero()` opens `zotero.sqlite` as `sqlite3.connect(f"file://{path}?immutable=1", uri=True)`.
`immutable=1` tells SQLite the file will not change during the connection and to
skip its usual locking, so a Zotero instance running at the same time is not
disturbed — but it also means very recent Zotero edits may not be visible until you
restart Zotero or re-run the import. The script never opens the database for
writing and never touches anything under Zotero's `storage/` directory; PDFs are
read and copied, never modified or moved.

## Where it looks for Zotero

Resolved in this order by `zotero_paths()`:

1. `--zotero-dir /path/to/Zotero` — uses `<dir>/zotero.sqlite` and `<dir>/storage`.
2. The environment variables `ZOTERO_DB_PATH` and `ZOTERO_STORAGE_PATH`.
3. The default: `~/Zotero/zotero.sqlite` and `~/Zotero/storage`.

`--zotero-dir` and the environment variables are independent — `--zotero-dir` wins
if given; otherwise each of `ZOTERO_DB_PATH` / `ZOTERO_STORAGE_PATH` is used if set,
falling back to `~/Zotero` for whichever one is not.

## CLI reference

| Flag | Meaning |
|---|---|
| `--list` | Print every Zotero collection with its item count, then exit. Does not import anything. |
| `-c NAME`, `--collection NAME` | A Zotero collection to import, by exact name. Repeatable — pass `-c` more than once to import several collections in one run. |
| `--zotero-dir DIR` | Zotero data directory (default `~/Zotero`; overrides `ZOTERO_DB_PATH`/`ZOTERO_STORAGE_PATH`). |
| `--data-dir DIR` | MyLibrary data directory to import into (default `./data`, same default as `mylibrary`). |
| `--tag NAME` | Tag to apply to every imported paper. Repeatable. If omitted, each paper is tagged with the name of the Zotero collection it came from. |
| `--dry-run` | Print what would be imported (title, and whether a local PDF was found) without writing anything to MyLibrary. |

At least one `-c/--collection` is required unless `--list` is passed.

## Duplicate handling

Each item is added through the same `LibraryService.add_candidate()` the CLI and
web UI use, so the same de-duplication rules apply: an item is matched against an
existing paper first by DOI or arXiv ID (whichever the Zotero item has), then by
normalized title (and year, if both have one). A match is enriched rather than
duplicated — re-importing the same collection, or a collection that overlaps one
you already have from arXiv/DOI, updates the existing paper instead of creating a
second one.

The PDF itself is de-duplicated by content: `attach_local_pdf` hashes the file and
only appends a new `StoredFile` row if that sha256 isn't already attached to the
paper, so re-running an import is safe and cheap.

Tags accumulate: running the same collection again, or the same paper through two
collections, adds tags rather than replacing them.

## Items with no stored PDF

If an item has no attachment that qualifies as a stored PDF copy (no PDF attachment
at all, or only a linked/external file), the paper is still imported with full
metadata — it just prints `NO-PDF-FILE` and has no PDF, no thumbnails, and no
figures until you attach one later (e.g. `mylibrary fetch-pdf` or the web UI's
"fetch PDF" action, if an open-access copy exists elsewhere).

## Output

```
# Reading List — 12 item(s)
  new  paper_id  status        title
--------------------------------------------------------------------------------
 True  3f9a2b1c  pdf+2fig      Attention Is All You Need
False  9c0e7d44  NO-PDF-FILE   A Survey of ...
 True  1a2b3c4d  SKIP(not-a-pdf)  ...
--------------------------------------------------------------------------------
done: 12/12 item(s) imported, 9 with local PDF + figures
```

`status` is one of: `pdf+<N>fig` (PDF copied, N figure thumbnails found),
`NO-PDF-FILE` (no qualifying attachment), or `SKIP(not-a-pdf)` (the attached file's
bytes did not start with `%PDF-`, so it was not copied in).

## Troubleshooting

- **`Zotero database not found: ...`** — pass `--zotero-dir`, or set
  `ZOTERO_DB_PATH`, to the correct location. On macOS the default Zotero data
  directory is usually `~/Zotero`; check Zotero's own
  Settings → Advanced → "Data Directory Location" if it was moved.
- **`! collection 'X' is empty or does not exist`** — collection names must match
  exactly (case-insensitively); run `--list` to see the exact names and item
  counts Zotero reports.
- **`NO-TITLE`** — the Zotero item has no title field and is skipped; fix the title
  in Zotero and re-run.
- **A PDF you can see in Zotero is not imported** — it may be a *linked* file
  (link mode outside `imported_file`/`imported_url`), e.g. a path into an external
  folder or cloud sync target rather than Zotero's own `storage/` copy. Only
  Zotero-managed copies are read.
- **Recent Zotero edits are missing** — the immutable read may have opened a
  slightly stale view; close Zotero (or wait for it to finish writing) and re-run.
- **Running while `mylibrary run`/`serve` is active** — the importer sets a 15s
  SQLite `busy_timeout` on its MyLibrary connection specifically so it can coexist
  with the running web server without failing on a lock; if you still hit
  `database is locked`, stop the server for the duration of the import.
