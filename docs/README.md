# Docs index

## Guides

- [`architecture.md`](architecture.md) — how the pieces fit: package layout, the
  `add` request path, content-addressed storage, thumbnails/figures, the database
  schema, the front-end module layout, and where data lives on disk.
- [`zotero-import.md`](zotero-import.md) — full guide to `zotero_import.py`: flags,
  what it reads from Zotero's SQLite, duplicate handling, and troubleshooting.
- [`ai-integration.md`](ai-integration.md) — the annotation-context API for external
  agents: routes, payload shapes, curl examples, and a security note.
- [`study-notes.md`](study-notes.md) — the study view: lecture notes beside the PDF,
  shared concept notes via `[[wikilinks]]`, and which Markdown features actually
  render.
- [`remote-access.md`](remote-access.md) — reaching the library from another device
  without exposing it on the public internet.

## Screenshots

Captured from a demo library built only from well-known public arXiv papers:

- [`images/timeline.png`](images/timeline.png) — the figure-first timeline
- [`images/reader.png`](images/reader.png) — the PDF reader with the annotation sidebar
- [`images/study.png`](images/study.png) — the study view, PDF beside rendered notes
- [`images/lightbox.png`](images/lightbox.png) — the full-screen figure lightbox
- [`images/wiki.png`](images/wiki.png) — the in-app workflow wiki
- [`images/paper.png`](images/paper.png) — a paper's metadata page
