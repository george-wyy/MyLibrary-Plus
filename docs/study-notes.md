# Study view and shared notes

The study view is a side-by-side (or stacked) reading surface: the paper's PDF on the
left, your own Markdown notes about it on the right, with the same annotation system
as the plain reader working across both.

## Files and routes

| On disk | Route | Served by |
|---|---|---|
| `data/lectures/<paper_id>.md` | `/paper/{id}/study` (page), `/paper/{id}/lecture.md` (raw text) | `web/app.py` |
| `data/lectures/<paper_id>__<slug>.md` | same two routes, plus `?variant=<slug>` / `/api/papers/{id}/lectures` | `web/app.py` |
| `data/lectures/assets/<paper_id>/…` | `/paper/{id}/lecture-asset/<path>` | `web/app.py` |
| `data/notes/<slug>.md` | `/api/notes/{slug}` (JSON: markdown + backlinks) | `web/app.py` |

- `/paper/{id}/study` (`paper_study` in `app.py`) 404s if the paper has no stored PDF
  *or* no `data/lectures/{id}.md` file yet — the study view only exists once you've
  written notes for that paper. There is no "create notes" button; you create the
  file yourself. `?file_id=N` picks which stored file (main PDF or supplement) the
  PDF pane loads.
- `GET /paper/{id}/lecture.md` serves that file's raw Markdown (used by `study.js` to
  fetch and render it); it 404s the same way if the file is missing. Add
  `?variant=<slug>` to serve an extra lecture instead of the main one.
- `GET /api/papers/{id}/lectures` lists the paper's lectures — `[{"slug": "",
  "title": "…"}]` for the main one, then one entry per `<paper_id>__<slug>.md`, titled
  by the file's first `# ` heading — and is what populates the study view's picker.
- `GET /paper/{id}/lecture-asset/<path>` serves a widget component out of
  `data/lectures/assets/<paper_id>/`. The path is resolved and then checked to still
  be inside that folder (so `..`, absolute paths and symlinks out are a 404), and only
  extensions on the server's allow-list are served (`.html .htm .js .mjs .css .json
  .csv .txt .png .jpg .jpeg .webp .gif .svg .woff2`) — anything else is a 415.
  Responses are `Cache-Control: no-cache` plus `X-Content-Type-Options: nosniff`.
- `GET /api/notes/{slug}` reads `data/notes/{slug}.md` (the slug is filtered down to
  alphanumeric characters plus `-`/`_` — Python's `str.isalnum()`, so Unicode
  letters/digits pass through too, not just ASCII) and returns
  `{"slug", "markdown", "backlinks"}`. `backlinks` is
  computed by scanning every file in `data/lectures/*.md` for the literal token
  `[[slug` and resolving each match back to its paper — this is a simple substring
  scan, not a Markdown parser, so it can't tell a live wikilink from one inside a
  code fence. The paper id is taken as the part before `__`, and a paper cited from
  several of its lectures is listed once.
- `GET /api/notes/{slug}/annotations` returns every annotation across the library
  whose `anchor.note_slug` matches, each with an added `paper_title` — this is what
  populates highlights inside the concept-note popover and lets an annotation made
  in a shared note surface from any paper that links to it.

Neither directory is created automatically by `mylibrary init`; create
`data/lectures/` or `data/notes/` yourself the first time you add a file.

## Several lectures for one paper

A paper's main lecture is `<paper_id>.md`. Every additional file named
`<paper_id>__<slug>.md` is a second lecture on the same paper — `<slug>` is sanitised
to alphanumerics plus `-`/`_` (the double underscore can never occur in a UUID, so the
split is unambiguous). Old annotations need no migration: an annotation whose
`anchor.lecture_slug` is absent or `""` belongs to the main lecture.

Typical use: `<id>.md` is the overview, `<id>__priors.md` the background primer,
`<id>__chapter-3.md` one chapter in depth. All of them share the paper's PDF pane,
notes zoom setting, and annotation sidebar; annotations record which lecture they came
from so a highlight only appears in the lecture it was made in.

## Authoring a note file

A lecture file is just Markdown, named after the paper's UUID (from `mylibrary show`
or the paper detail page's URL):

```
data/lectures/6b2f9d10-2222-4b6b-8d2f-1a3c5e7b9002.md
```

A concept note is Markdown named after its slug:

```
data/notes/self-attention.md
```

Link to a concept note from any lecture (or from another concept note) with
`[[slug]]` or `[[slug|display text]]`:

```markdown
This relies on [[self-attention]] rather than recurrence — see also
[[self-attention|the scaled dot-product variant]] used here.
```

`study.js`'s `linkifyWikilinks` turns each `[[...]]` into a clickable button before
handing the text to Marked; clicking it opens a draggable, resizable floating
popover (`floating-window.mjs`) that fetches and renders `/api/notes/{slug}`,
including its backlinks list. The slug inside `[[...]]` must match the note's
filename (minus `.md`); `#` and `|` are not allowed inside the slug portion.

## Supported Markdown features

Both the lecture pane (`study.js`) and the concept-note popover render through the
same pipeline: `marked` (GFM mode) for structure, with a pre/post pass
(`math-markdown.mjs`) for math, then a conservative HTML sanitizer that strips
`<script>`/`<iframe>`/event-handler attributes/`javascript:` URLs.

- **GFM Markdown** — headings, lists, tables, code fences, blockquotes, links
  (rendered links get `target="_blank" rel="noopener noreferrer"`), inline images.
- **KaTeX math** — `$inline$`, `$$display$$`, `\(inline\)`, and `\[display\]` are
  masked before Marked runs (so `_`/`*` inside a formula are not eaten as Markdown
  emphasis) and rendered with the vendored KaTeX afterward. Formulas inside fenced
  code blocks are left as literal text, not rendered.
- **Figures** — a plain `![alt](url)` image is styled by `.markdown-body img`. For a
  captioned figure, write raw HTML directly in the Markdown — Marked passes
  block-level HTML through, and the sanitizer only removes dangerous tags/attributes,
  not `<figure>`/`<figcaption>`:
  ```html
  <figure>
    <img src="/paper/6b2f9d10-.../thumbnail?source=figure-1" alt="Model diagram">
    <figcaption>Figure 1 from the paper.</figcaption>
  </figure>
  ```
- **Callout boxes** — likewise raw HTML, styled by the `.bg-box`/`.bg-title` classes
  defined in `study.html`'s inline CSS. There is no special callout syntax (no
  `> [!NOTE]`-style shorthand) — write the wrapper yourself:
  ```html
  <div class="bg-box">
    <span class="bg-title">Background</span>
    Positional encodings are added because attention itself is permutation-invariant.
  </div>
  ```
- **`[[wikilinks]]`** — see above; rendered client-side before Marked runs, so they
  work inside any block Marked would otherwise leave untouched.
- **Interactive widgets** — a fenced ` ```widget ` block becomes an iframe pointing at
  a file you put in `data/lectures/assets/<paper_id>/`. The block body is `key: value`
  lines (first colon splits, `#` comments and blank lines ignored, first occurrence of
  a key wins):
  ````markdown
  ```widget
  src: dragcal-explorer.html#step=gating   # required, relative to the paper's asset dir
  height: 640                              # optional, default 600, clamped to 200–2400
  title: Interactive: the four gates       # optional iframe title
  ```
  ````
  `study.js`'s `renderWidgetBlocks` parses the block with `resolveWidgetBlock`
  (`lecture-widget.mjs`, unit-tested in `tests/test_lecture_widget.mjs`) and swaps in
  an iframe; a bad `src` (a protocol, an absolute path, `..`, backslashes, whitespace,
  bad percent-encoding) turns into an inline error message instead of a request. The
  sanitizer runs before the block is extracted, so a widget can only load a file from
  its own paper's asset directory. The iframe is `sandbox="allow-scripts
  allow-same-origin allow-popups"` — same-origin deliberately, because the asset is a
  file you put there yourself (a widget needs the vendored KaTeX fonts and
  `localStorage`), which also means a widget can reach the parent page; only put
  assets you trust in that directory. Two messages are exchanged with the widget:
  the parent posts `{type: "mylibrary-theme", theme}` on load and on every theme
  switch (so the widget can match 夜览模式), and a widget can post
  `{type: "mylibrary-widget-height", height}` to grow its own frame (clamped to
  200–2400px).

**Mermaid is not rendered in lecture or concept-note Markdown.** The vendored
`static/vendor/mermaid/mermaid.min.js` is loaded and initialized only on the
built-in `/wiki` page (`templates/wiki.html`); `templates/study.html` does not load
it and `study.js` never calls it. A ` ```mermaid ` fence in a lecture file will
render as an inert code block, not a diagram — use a ` ```widget ` block with a
pre-rendered SVG/HTML file if you need a diagram there.

## Annotations in notes and lectures

Selecting text in the lecture pane or inside an open concept-note popover opens the
same inline composer as the PDF reader, and produces the same annotation records
(`target_type: "lecture"` or `"note"` — see `docs/ai-integration.md` for the JSON
shape), listed in the same sidebar/floating-window `AnnotationPanel` as PDF
highlights. A few things follow from sharing one anchoring/rendering system:

- Because the text is Markdown rendered to HTML, `lecture`/`note` annotations anchor
  to **character offsets into the rendered text**, not into the Markdown source.
  Editing the file can shift or break an existing anchor; `resolveLectureAnchor`
  handles this by falling back to the annotation's stored `exact` text, and — if
  that text occurs more than once — scoring candidate matches by how well their
  surrounding `prefix`/`suffix` match what was recorded when the annotation was made.
- Concept-note annotations are shared: an annotation made in `[[self-attention]]`
  from one paper's lecture shows up in the popover (and in `GET
  /api/notes/{slug}/annotations`) no matter which paper you reach it from. Clicking
  a highlight that belongs to a *different* paper's PDF or lecture navigates you to
  that paper's reader/study page instead of opening it inline.
- The zoom control on the notes pane (`Ctrl`/`Cmd` + `+`/`-`, or the `A−`/`A+`
  buttons) only scales font size for reading comfort; it has no effect on annotation
  anchoring.
