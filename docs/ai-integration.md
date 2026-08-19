# AI / agent integration

MyLibrary exposes the reader's PDF and study-notes annotations as a small JSON API,
designed so an external agent can read a thread of highlights and notes on a paper
and reply back into it. The in-browser annotation panel and an external agent read
and write the exact same records — a reply posted by `curl` shows up in the sidebar
immediately.

All routes below live in `src/mylibrary/web/app.py` and are implemented by
`LibraryService` in `src/mylibrary/services/library.py`. There is no separate "AI"
service; it is the same annotation storage the reader UI uses.

## Routes

### `GET /api/papers/{paper_id}/annotations/context`

The primary route for handing context to an agent: one paper plus all of its
annotations, with instructions on how to reply.

- `404` if `paper_id` does not exist.
- `200` → see the example response below.

### `GET /api/papers/{paper_id}/annotations`

All annotations for one paper (PDF, lecture, and note-targeted), as a plain array —
no wrapping `paper`/`instructions` object.

- `404` if the paper does not exist.
- `200` → `[ {...annotation...}, ... ]`

### `GET /api/annotations`

Every annotation across the whole library, each with an extra `paper_title` field.
Useful for an agent that wants to scan the whole library rather than one paper.

### `POST /api/papers/{paper_id}/annotations`

Creates a new annotation. JSON body:

| Field | Type | Notes |
|---|---|---|
| `page_number` | int | Required for `target_type: "pdf"` (1-based); ignored/`0` otherwise |
| `selected_text` | string | Required, non-empty |
| `rects` | array of `{x,y,width,height}` | Required for `pdf` annotations; normalized 0..1 page fractions |
| `color` | string | One of `yellow red green blue purple pink orange gray`; default `yellow` |
| `note` | string \| null | Optional free-text/Markdown note |
| `target_type` | string | `"pdf"` (default), `"lecture"`, or `"note"` |
| `anchor` | object | Required for `lecture`/`note`: `{start, end}` character offsets into the rendered text (`prefix`/`suffix` optional context for re-anchoring); `note` additionally requires `anchor.note_slug` |
| `tags` | array of strings | Optional, max 20 |

- `400` on any validation error (bad color, missing rects/anchor, empty text, …).
- `404` if the paper does not exist.
- `201` → the created annotation JSON.

### `PATCH /api/papers/{paper_id}/annotations/{annotation_id}`

Partial update. Body may include any of `note`, `color`, `tags` — omitted fields are
left unchanged. `400` on validation error, `404` if the annotation (or its paper
match) is not found, `200` → the updated annotation JSON.

### `POST /api/papers/{paper_id}/annotations/{annotation_id}/replies`

Appends a threaded reply. JSON body: `{"content": "...", "role": "user"}`. This is
the route an agent uses to answer back into a thread — post `role: "assistant"`.

- `role` must be `"user"` or `"assistant"`; anything else is `400`.
- `content` must be non-empty (truncated to 10,000 characters).
- `404` if the annotation/paper is not found.
- `201` → the created reply JSON (see shape below).

### `DELETE /api/papers/{paper_id}/annotations/{annotation_id}`

Deletes the annotation and its replies. `204` on success, `404` if not found.

## Annotation JSON shape

Produced by `_annotation_json` in `web/app.py`:

```json
{
  "id": "a1e2c3f4-1111-4a5a-9c1e-8f2b7d6a0001",
  "paper_id": "6b2f9d10-2222-4b6b-8d2f-1a3c5e7b9002",
  "target_type": "pdf",
  "page_number": 1,
  "selected_text": "the Transformer, a model architecture eschewing recurrence",
  "rects": [{"x": 0.12, "y": 0.31, "width": 0.42, "height": 0.02}],
  "anchor": {"exact": "the Transformer, a model architecture eschewing recurrence"},
  "color": "yellow",
  "note": "Core claim of the paper — check against the ablations in §6.",
  "tags": ["core-claim"],
  "created_at": "2026-08-19T02:14:07+00:00",
  "updated_at": "2026-08-19T02:14:07+00:00",
  "replies": []
}
```

`replies[]` entries: `{"id", "annotation_id", "role", "content", "created_at"}`.
Timestamps are ISO 8601 UTC. For `lecture`/`note` annotations, `anchor` also carries
`start`/`end`/`prefix`/`suffix` (and `note_slug` for `note`); `rects` is `[]` and
`page_number` is `0`.

## Example: reading and replying to context

Fabricated but schema-accurate example for a paper already in the library —
"Attention Is All You Need" (Vaswani et al., 2017):

```bash
PAPER_ID=6b2f9d10-2222-4b6b-8d2f-1a3c5e7b9002

curl -s http://127.0.0.1:8765/api/papers/$PAPER_ID/annotations/context
```

```json
{
  "paper": {
    "id": "6b2f9d10-2222-4b6b-8d2f-1a3c5e7b9002",
    "title": "Attention Is All You Need",
    "authors": ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
    "year": 2017
  },
  "instructions": "These are the reader's private annotations. Use the selected text and location as context. Continue a thread by POSTing plain text to its replies endpoint with role=assistant.",
  "annotations": [
    {
      "id": "a1e2c3f4-1111-4a5a-9c1e-8f2b7d6a0001",
      "paper_id": "6b2f9d10-2222-4b6b-8d2f-1a3c5e7b9002",
      "target_type": "pdf",
      "page_number": 1,
      "selected_text": "the Transformer, a model architecture eschewing recurrence",
      "rects": [{"x": 0.12, "y": 0.31, "width": 0.42, "height": 0.02}],
      "anchor": {"exact": "the Transformer, a model architecture eschewing recurrence"},
      "color": "yellow",
      "note": "Why drop recurrence entirely — what does that buy them?",
      "tags": ["core-claim"],
      "created_at": "2026-08-19T02:14:07+00:00",
      "updated_at": "2026-08-19T02:14:07+00:00",
      "replies": []
    }
  ]
}
```

Reply as the agent:

```bash
ANNOTATION_ID=a1e2c3f4-1111-4a5a-9c1e-8f2b7d6a0001

curl -s -X POST \
  http://127.0.0.1:8765/api/papers/$PAPER_ID/annotations/$ANNOTATION_ID/replies \
  -H 'Content-Type: application/json' \
  -d '{"role": "assistant", "content": "Dropping recurrence removes the sequential dependency that blocks parallelization across positions; self-attention lets every position attend to every other in O(1) sequential steps (§3.2)."}'
```

Create a fresh highlight-free note annotation (an agent's own observation, anchored
to a page without selecting text in the UI first is not supported — `selected_text`
and, for PDF targets, `rects` are required):

```bash
curl -s -X POST http://127.0.0.1:8765/api/papers/$PAPER_ID/annotations \
  -H 'Content-Type: application/json' \
  -d '{
        "target_type": "pdf",
        "page_number": 3,
        "selected_text": "scaled dot-product attention",
        "rects": [{"x": 0.10, "y": 0.20, "width": 0.35, "height": 0.02}],
        "color": "blue",
        "note": "Compare to additive attention (Bahdanau) — why is dot-product faster in practice?"
      }'
```

## Wiring into an agent loop

1. Poll or fetch `GET /api/papers/{id}/annotations/context` (or `GET /api/annotations`
   to scan the whole library) to get the current thread state.
2. Treat `annotations[].replies` where `role == "assistant"` as things you've
   already said, so you don't re-answer the same thread.
3. For each annotation that has a new `user` reply (or is unanswered), form a
   response using `selected_text` and `note` as context, and `POST` it to
   `.../annotations/{annotation_id}/replies` with `"role": "assistant"`.
4. Optionally `PATCH` the annotation's `tags` to mark it as triaged/answered so a
   future poll can filter on that instead of re-reading full thread state.
5. The reader's own "copy AI context" button (in the sidebar) copies the same
   `annotations/context` JSON to the clipboard for a manual paste-in workflow —
   the API and that button are two entry points to the same data.

## Security note

There is **no authentication** on any route, and the server binds to `127.0.0.1`
by default. This API is designed for a trusted local agent (or one reached over a
private network overlay — see `docs/remote-access.md`), not for exposure on a
shared or public network. Do not put it behind a public reverse proxy without
adding your own auth layer in front of it.
