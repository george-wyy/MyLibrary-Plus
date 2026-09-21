# Example library

A small, ready-made library so you can see every screen of MyLibrary-Plus without
importing anything — and so an agent can verify an install end to end before touching
real papers. Everything here is built from well-known public arXiv preprints; the
metadata comes from the papers themselves, the notes and annotations were written for
this example.

## Run it (2 minutes)

```bash
cp -R examples/data ./data        # the app reads <repo>/data by default
./mylibrary serve                 # http://127.0.0.1:8765
```

`--data-dir` works too if you keep your library elsewhere:

```bash
./mylibrary serve --data-dir examples/data --port 8799
```

## Verify it

```bash
python3 examples/verify.py            # files, database, `mylibrary init` (no server)
python3 examples/verify.py --serve    # + boots the app on a free port and checks routes
```

The script exits non-zero with a list of failures, so a person or an agent can use it
as the "did the install work?" gate. It checks the routes the README advertises, that
the lecture picker sees both lectures, that a widget component is served, and that a
path-traversal attempt out of the asset folder is refused.

## What is in here

```
examples/
├── data/                      # a complete library directory
│   ├── library.sqlite3        # metadata, tags, notes, annotations for 8 papers
│   ├── files/…pdf             # 4 of the 8 papers ship with their PDF
│   ├── thumbnails/…           # page 1 + figure previews for those 4
│   ├── lectures/
│   │   ├── <paper_id>.md             # the main study note (Attention Is All You Need)
│   │   ├── <paper_id>__interactive.md  # a second lecture on the same paper → lecture picker
│   │   └── assets/<paper_id>/softmax-temperature.html  # a live ```widget component
│   └── notes/
│       ├── self-attention.md         # shared concept notes…
│       └── positional-encoding.md    # …reached from a lecture via [[wikilinks]]
└── verify.py
```

The `data/` shape is the same one your own library uses — see
[docs/architecture.md](../docs/architecture.md) for the full layout and
[docs/study-notes.md](../docs/study-notes.md) for authoring notes and widgets.

## Where to look for what

| Want to see | Open |
|---|---|
| Figure-first timeline, tags, verdicts | `/` (Attention, BERT, ResNet and Adam have PDFs and figures) |
| Text annotations + replies, annotation filters | `/paper/9f97e37b-408e-4fdb-a775-1a46ed222500/read` → 批注 sidebar |
| A **figure region** annotation (4th entry) | same reader, page 3 of Attention |
| Study view: PDF beside rendered notes | `/paper/9f97e37b-408e-4fdb-a775-1a46ed222500/study` |
| The lecture picker (two lectures) | the dropdown left of 批注 in the study head |
| A live embedded component | study view → pick "Attention, interactively" → scroll to the widget |
| Dark mode | the 🌙 button in the header (system → light → dark) |
| Concept notes and backlinks | click a highlighted `[[self-attention]]` in either lecture |
| The agent-facing JSON | `curl localhost:8765/api/papers/9f97e37b-408e-4fdb-a775-1a46ed222500/annotations/context` |

The other four papers in the database (ViT, CLIP, DDPM, Mamba) are metadata-only here:
the PDFs are not bundled, so they show a placeholder card. That is exactly what a
paper looks like in your own library if you add metadata without a downloadable PDF.
To fill them in:

```bash
./mylibrary add https://arxiv.org/abs/2010.11929   # ViT
./mylibrary thumbnails --force                     # rebuild previews
```

## Making it your own

`data/` is disposable — delete it and start over. The fastest path from here:

1. `./mylibrary add "A paper you care about"` (or `python zotero_import.py -c "Reading list"`)
2. Write `data/lectures/<paper_id>.md` — plain Markdown; figures, math, callouts and
   `[[wikilinks]]` all render. Copy the shape of the Attention study note.
3. Add extra lectures as `data/lectures/<paper_id>__<slug>.md`, and components under
   `data/lectures/assets/<paper_id>/` when a ` ```widget ` block should be interactive.
4. Write `data/notes/<slug>.md` for concepts you want to reuse across papers.
5. Annotate from the UI, or drive it from an agent through the API in
   [docs/ai-integration.md](../docs/ai-integration.md).

## Licensing

The bundled PDFs are the authors' arXiv preprints, included unchanged with their
source URLs in the database so attribution is verifiable; they are redistributed for
non-commercial, educational use. If you fork this for a commercial product, drop
`files/` and `thumbnails/` and re-add papers with `./mylibrary add`. Everything else
here (notes, widget, verification script) is MIT, same as the project.
