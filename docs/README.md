# Docs index

## Guides

- [`../examples/`](../examples/) — a ready-made example library (public papers, tags,
  lecture notes, concept notes, annotations) plus `verify.py`, for seeing every screen
  and checking an install end to end before importing your own papers.
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
- [`images/reader-region.png`](images/reader-region.png) — a figure selected as one region annotation
- [`images/study.png`](images/study.png) — the study view, PDF beside rendered notes
- [`images/study-stacked.png`](images/study-stacked.png) — the same view stacked top/bottom
- [`images/widget.png`](images/widget.png) — an interactive component embedded in a lecture
- [`images/timeline-night.png`](images/timeline-night.png) — the timeline in dark mode
- [`images/study-night.png`](images/study-night.png) — the study view in dark mode
- [`images/lightbox.png`](images/lightbox.png) — the full-screen figure lightbox
- [`images/wiki.png`](images/wiki.png) — the in-app workflow wiki
- [`images/paper.png`](images/paper.png) — a paper's metadata page
