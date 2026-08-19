# Study view and shared notes

The study view is a side-by-side reading surface: the paper's PDF on the left, your
own Markdown notes about it on the right, with the same annotation system as the
plain reader working across both.

## Files and routes

| On disk | Route | Served by |
|---|---|---|
| `data/lectures/<paper_id>.md` | `/paper/{id}/study` (page), `/paper/{id}/lecture.md` (raw text) | `web/app.py` |
| `data/notes/<slug>.md` | `/api/notes/{slug}` (JSON: markdown + backlinks) | `web/app.py` |

- `/paper/{id}/study` (`paper_study` in `app.py`) 404s if the paper has no stored PDF
  *or* no `data/lectures/{id}.md` file yet — the study view only exists once you've
  written notes for that paper. There is no "create notes" button; you create the
  file yourself.
- `GET /paper/{id}/lecture.md` serves that file's raw Markdown (used by `study.js` to
  fetch and render it); it 404s the same way if the file is missing.
- `GET /api/notes/{slug}` reads `data/notes/{slug}.md` (the slug is filtered down to
  alphanumeric characters plus `-`/`_` — Python's `str.isalnum()`, so Unicode
  letters/digits pass through too, not just ASCII) and returns
  `{"slug", "markdown", "backlinks"}`. `backlinks` is
  computed by scanning every file in `data/lectures/*.md` for the literal token
  `[[slug` and resolving each match back to its paper — this is a simple substring
  scan, not a Markdown parser, so it can't tell a live wikilink from one inside a
  code fence.
- `GET /api/notes/{slug}/annotations` returns every annotation across the library
  whose `anchor.note_slug` matches, each with an added `paper_title` — this is what
  populates highlights inside the concept-note popover and lets an annotation made
  in a shared note surface from any paper that links to it.

Neither directory is created automatically by `mylibrary init`; create
`data/lectures/` or `data/notes/` yourself the first time you add a file.

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

**Mermaid is not rendered in lecture or concept-note Markdown.** The vendored
`static/vendor/mermaid/mermaid.min.js` is loaded and initialized only on the
built-in `/wiki` page (`templates/wiki.html`); `templates/study.html` does not load
it and `study.js` never calls it. A ` ```mermaid ` fence in a lecture file will
render as an inert code block, not a diagram. (The top-level README's feature list
mentions Mermaid for the study view — that is aspirational/inaccurate as of this
version; treat this file as the source of truth.)

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
