from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote_plus, urlencode
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from ..config import Settings
from ..services.library import AmbiguousMatch, LibraryService


WEB_DIR = Path(__file__).parent
THUMBNAIL_VERSION = "5"
LOCAL_TIMEZONE = ZoneInfo("Asia/Singapore")
MARKER_OPTIONS = [
    ("", "Empty"), ("thumbup", "Thumbs up"), ("thumbdown", "Thumbs down"),
    ("star", "Star"), ("question", "Question"), ("check", "Read"), ("wrong", "Wrong"),
]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.create()
    service = LibraryService(settings)
    app = FastAPI(title="MyLibrary", docs_url="/api/docs")
    app.state.library = service
    templates = Jinja2Templates(directory=WEB_DIR / "templates")
    templates.env.filters["author_summary"] = _author_summary
    templates.env.filters["tag_style"] = _tag_style
    templates.env.filters["citation_max"] = _citation_max
    templates.env.filters["local_time"] = _local_time
    templates.env.filters["timeline_day"] = _timeline_day
    app.mount("/static", StaticFiles(directory=WEB_DIR / "static"), name="static")

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon() -> FileResponse:
        return FileResponse(WEB_DIR / "static" / "favicon.ico", media_type="image/x-icon")

    def _timeline_context(request: Request, papers, q: str | None, thumbnail: str | None, lecture: str | None):  # type: ignore[no-untyped-def]
        """Shared timeline payload: applies the 讲义 filter and builds its chip links."""
        thumbnail_source = thumbnail if thumbnail in LibraryService.THUMBNAIL_SOURCES else None
        lecture_only = lecture in ("1", "true", "yes")
        card_lectures = {paper.id: _lecture_file(settings, paper.id).exists() for paper in papers}
        counts = {"all": len(papers), "lecture": sum(1 for value in card_lectures.values() if value)}
        if lecture_only:
            papers = [paper for paper in papers if card_lectures[paper.id]]
        base_params = [("q", q)] if q else []
        if thumbnail_source:
            base_params.append(("thumbnail", thumbnail_source))
        path = request.url.path
        filter_links = {
            "all": f"{path}?{urlencode(base_params)}" if base_params else path,
            "lecture": f"{path}?{urlencode(base_params + [('lecture', '1')])}",
        }
        return {
            "papers": papers,
            "card_sources": {paper.id: _card_sources(settings, service, paper) for paper in papers},
            "card_lectures": card_lectures,
            "q": q or "",
            "thumbnail_source": thumbnail_source,
            "thumbnail_version": THUMBNAIL_VERSION,
            "marker_options": MARKER_OPTIONS,
            "lecture_only": lecture_only,
            "filter_counts": counts,
            "filter_links": filter_links,
        }

    @app.get("/")
    async def index(request: Request, q: str | None = None, message: str | None = None, thumbnail: str | None = None, lecture: str | None = None):  # type: ignore[no-untyped-def]
        context = _timeline_context(request, service.list_papers(q), q, thumbnail, lecture)
        return templates.TemplateResponse(request, "index.html", {**context, "message": message, "active_tag": None})

    @app.get("/add")
    async def add_page(request: Request):  # type: ignore[no-untyped-def]
        return templates.TemplateResponse(request, "add.html", {})

    @app.get("/wiki")
    async def wiki_page(request: Request):  # type: ignore[no-untyped-def]
        return templates.TemplateResponse(request, "wiki.html", {})

    @app.get("/tags")
    async def tags_overview(request: Request):  # type: ignore[no-untyped-def]
        return templates.TemplateResponse(request, "tags.html", {"tags": service.list_tags()})

    @app.get("/tags/{tag_id}")
    async def tag_timeline(request: Request, tag_id: int, q: str | None = None, thumbnail: str | None = None, lecture: str | None = None):  # type: ignore[no-untyped-def]
        tag = service.get_tag(tag_id)
        if tag is None:
            raise HTTPException(404, "Tag not found")
        context = _timeline_context(request, service.list_papers(q, tag_id), q, thumbnail, lecture)
        return templates.TemplateResponse(request, "index.html", {**context, "message": None, "active_tag": tag})

    @app.post("/add")
    async def add_paper(request: Request, query: str = Form(...), no_pdf: bool = Form(False)):  # type: ignore[no-untyped-def]
        try:
            result = await service.add(query, download_pdf=not no_pdf)
            return RedirectResponse(f"/paper/{result.paper_id}?message={quote_plus(result.message)}", status_code=303)
        except AmbiguousMatch as error:
            return templates.TemplateResponse(request, "candidates.html", {"query": query, "candidates": error.candidates, "no_pdf": no_pdf}, status_code=409)
        except LookupError as error:
            return templates.TemplateResponse(request, "error.html", {"message": str(error)}, status_code=404)

    @app.post("/add/selected")
    async def add_selected(query: str = Form(...), candidate_index: int = Form(...), no_pdf: bool = Form(False)):  # type: ignore[no-untyped-def]
        result = await service.add(query, candidate_index=candidate_index, download_pdf=not no_pdf)
        return RedirectResponse(f"/paper/{result.paper_id}?message={quote_plus(result.message)}", status_code=303)

    @app.get("/paper/{paper_id}")
    async def paper_detail(request: Request, paper_id: str, message: str | None = None):  # type: ignore[no-untyped-def]
        paper = service.get_paper(paper_id)
        if not paper:
            raise HTTPException(404, "Paper not found")
        available_sources = ["page-1"]
        if paper.files:
            stored = paper.files[0]
            for source in ("figure-1", "figure-2", "figure-3"):
                path = settings.managed_path(service.files.thumbnail_relative_path(stored.sha256, source))
                if path.exists():
                    available_sources.append(source)
        return templates.TemplateResponse(request, "paper.html", {"paper": paper, "message": message, "thumbnail_version": THUMBNAIL_VERSION, "available_thumbnail_sources": available_sources, "has_lecture": _lecture_file(settings, paper_id).exists()})

    @app.get("/paper/{paper_id}/pdf")
    async def paper_pdf(paper_id: str):  # type: ignore[no-untyped-def]
        paper = service.get_paper(paper_id)
        if not paper or not paper.files:
            raise HTTPException(404, "PDF not found")
        path = settings.managed_path(paper.files[0].relative_path)
        return FileResponse(path, media_type="application/pdf", filename=f"{paper.title}.pdf", content_disposition_type="inline")

    @app.get("/paper/{paper_id}/download")
    async def download_paper(paper_id: str):  # type: ignore[no-untyped-def]
        paper = service.get_paper(paper_id)
        if not paper or not paper.files:
            raise HTTPException(404, "PDF not found")
        path = settings.managed_path(paper.files[0].relative_path)
        return FileResponse(path, media_type="application/pdf", filename=f"{paper.title}.pdf", content_disposition_type="attachment")

    @app.get("/paper/{paper_id}/figures")
    async def paper_figures(paper_id: str):  # type: ignore[no-untyped-def]
        paper = service.get_paper(paper_id)
        if not paper or not paper.files:
            return JSONResponse([])
        regions = await asyncio.to_thread(service.files.image_regions, paper.files[0].relative_path)
        return JSONResponse(regions)

    @app.get("/paper/{paper_id}/lecture.md")
    async def paper_lecture_md(paper_id: str):  # type: ignore[no-untyped-def]
        path = _lecture_file(settings, paper_id)
        if not path.exists():
            raise HTTPException(404, "No study notes for this paper")
        return FileResponse(path, media_type="text/markdown; charset=utf-8")

    @app.get("/api/notes/{slug}")
    async def concept_note(slug: str):  # type: ignore[no-untyped-def]
        safe = "".join(ch for ch in slug if ch.isalnum() or ch in "-_")
        path = settings.data_dir / "notes" / f"{safe}.md"
        if not safe or not path.exists():
            raise HTTPException(404, "Concept note not found")
        markdown = path.read_text(encoding="utf-8")
        backlinks = []
        lectures_dir = settings.data_dir / "lectures"
        if lectures_dir.exists():
            token = f"[[{safe}"
            for lecture_path in sorted(lectures_dir.glob("*.md")):
                try:
                    if token in lecture_path.read_text(encoding="utf-8"):
                        paper = service.get_paper(lecture_path.stem)
                        backlinks.append({"paper_id": lecture_path.stem, "title": paper.title if paper else lecture_path.stem})
                except OSError:
                    continue
        return JSONResponse({"slug": safe, "markdown": markdown, "backlinks": backlinks})

    @app.get("/api/notes/{slug}/annotations")
    async def concept_note_annotations(slug: str):  # type: ignore[no-untyped-def]
        safe = "".join(ch for ch in slug if ch.isalnum() or ch in "-_")
        return [
            {**_annotation_json(item), "paper_title": item.paper.title if item.paper else None}
            for item in service.list_note_annotations(safe)
        ]

    @app.get("/paper/{paper_id}/study")
    async def paper_study(request: Request, paper_id: str):  # type: ignore[no-untyped-def]
        paper = service.get_paper(paper_id)
        if not paper or not paper.files:
            raise HTTPException(404, "Paper not found")
        if not _lecture_file(settings, paper_id).exists():
            raise HTTPException(404, "No study notes for this paper")
        return templates.TemplateResponse(request, "study.html", {"paper": paper})

    @app.get("/paper/{paper_id}/read")
    async def paper_reader(request: Request, paper_id: str):  # type: ignore[no-untyped-def]
        paper = service.get_paper(paper_id)
        if not paper or not paper.files:
            raise HTTPException(404, "PDF not found")
        annotations = [_annotation_json(item) for item in service.list_annotations(paper_id)]
        return templates.TemplateResponse(request, "reader.html", {"paper": paper, "annotations": annotations})

    @app.get("/api/papers/{paper_id}/annotations")
    async def list_annotations(paper_id: str):  # type: ignore[no-untyped-def]
        if service.get_paper(paper_id) is None:
            raise HTTPException(404, "Paper not found")
        return [_annotation_json(item) for item in service.list_annotations(paper_id)]

    @app.get("/api/annotations")
    async def list_all_annotations():  # type: ignore[no-untyped-def]
        return [
            {**_annotation_json(item), "paper_title": item.paper.title}
            for item in service.list_all_annotations()
        ]

    @app.get("/api/papers/{paper_id}/annotations/context")
    async def annotation_context(paper_id: str):  # type: ignore[no-untyped-def]
        paper = service.get_paper(paper_id)
        if paper is None:
            raise HTTPException(404, "Paper not found")
        annotations = [_annotation_json(item) for item in service.list_annotations(paper_id)]
        return {
            "paper": {
                "id": paper.id,
                "title": paper.title,
                "authors": [item.author.name for item in paper.authors],
                "year": paper.year,
            },
            "instructions": (
                "These are the reader's private annotations. Use the selected text and location as context. "
                "Continue a thread by POSTing plain text to its replies endpoint with role=assistant."
            ),
            "annotations": annotations,
        }

    @app.post("/api/papers/{paper_id}/annotations")
    async def create_annotation(request: Request, paper_id: str):  # type: ignore[no-untyped-def]
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("Annotation payload must be a JSON object")
            tags = body.get("tags", [])
            if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
                raise ValueError("Annotation tags must be an array of strings")
            annotation = service.add_annotation(
                paper_id,
                int(body.get("page_number", 0)),
                str(body.get("selected_text", "")),
                body.get("rects") if isinstance(body.get("rects"), list) else [],
                str(body.get("color", "yellow")),
                body.get("note"),
                target_type=str(body.get("target_type", "pdf")),
                anchor=body.get("anchor") if isinstance(body.get("anchor"), dict) else None,
                tags=tags,
            )
        except (TypeError, ValueError) as error:
            raise HTTPException(400, str(error)) from error
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        return JSONResponse(_annotation_json(annotation), status_code=201)

    @app.patch("/api/papers/{paper_id}/annotations/{annotation_id}")
    async def edit_annotation(request: Request, paper_id: str, annotation_id: str):  # type: ignore[no-untyped-def]
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("Annotation payload must be a JSON object")
            changes = {}
            if "note" in body:
                changes["note"] = body["note"]
            if "color" in body:
                changes["color"] = str(body["color"])
            if "tags" in body:
                tags = body["tags"]
                if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
                    raise ValueError("Annotation tags must be an array of strings")
                changes["tags"] = tags
            annotation = service.update_annotation(paper_id, annotation_id, **changes)
        except (TypeError, ValueError) as error:
            raise HTTPException(400, str(error)) from error
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        return JSONResponse(_annotation_json(annotation))

    @app.post("/api/papers/{paper_id}/annotations/{annotation_id}/replies")
    async def create_annotation_reply(request: Request, paper_id: str, annotation_id: str):  # type: ignore[no-untyped-def]
        try:
            body = await request.json()
            reply = service.add_annotation_reply(
                paper_id,
                annotation_id,
                str(body.get("content", "")),
                str(body.get("role", "user")),
            )
        except (TypeError, ValueError) as error:
            raise HTTPException(400, str(error)) from error
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        return JSONResponse(_annotation_reply_json(reply), status_code=201)

    @app.delete("/api/papers/{paper_id}/annotations/{annotation_id}", status_code=204)
    async def remove_annotation(paper_id: str, annotation_id: str):  # type: ignore[no-untyped-def]
        try:
            service.delete_annotation(paper_id, annotation_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @app.get("/paper/{paper_id}/thumbnail")
    async def paper_thumbnail(paper_id: str, source: str = "figure-1", size: str | None = None):  # type: ignore[no-untyped-def]
        paper = service.get_paper(paper_id)
        if not paper or not paper.files:
            raise HTTPException(404, "Thumbnail not found")
        stored = paper.files[0]
        if source not in LibraryService.THUMBNAIL_SOURCES:
            raise HTTPException(400, "Unknown thumbnail source")
        requested = settings.managed_path(service.files.thumbnail_relative_path(stored.sha256, source))
        if requested.exists():
            path = requested
        else:
            paths = await service.files.create_thumbnails(stored.relative_path, stored.sha256, arxiv_id=paper.arxiv_id, source_url=stored.source_url)
            selected = paths.get(source) or paths["page-1"]
            path = settings.managed_path(selected)
        # Cards ask for the small JPEG copy; the lightbox still gets the original.
        if size == "card":
            path = await asyncio.to_thread(service.files.card_variant, path)
        media_type = "image/jpeg" if path.suffix == ".jpg" else "image/png"
        # The version query parameter changes whenever thumbnail generation
        # changes, so the browser can safely retain this generated image.
        return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @app.post("/paper/{paper_id}/fetch-pdf")
    async def fetch_pdf(paper_id: str):  # type: ignore[no-untyped-def]
        found = await service.fetch_pdf(paper_id)
        message = "PDF downloaded." if found else "No openly accessible PDF was found."
        return RedirectResponse(f"/paper/{paper_id}?message={quote_plus(message)}", status_code=303)

    @app.post("/paper/{paper_id}/tags")
    async def add_paper_tag(paper_id: str, name: str = Form(...)):  # type: ignore[no-untyped-def]
        tag = service.add_tag(paper_id, name)
        return RedirectResponse(f"/paper/{paper_id}?message={quote_plus(f'Added tag {tag.name}.')}", status_code=303)

    @app.post("/paper/{paper_id}/tags/{tag_id}/remove")
    async def remove_paper_tag(paper_id: str, tag_id: int):  # type: ignore[no-untyped-def]
        service.remove_tag(paper_id, tag_id)
        return RedirectResponse(f"/paper/{paper_id}?message={quote_plus('Tag removed.')}", status_code=303)

    @app.post("/paper/{paper_id}/done")
    async def set_paper_done(request: Request, paper_id: str, done: bool = Form(...), return_to: str | None = Form(None)):  # type: ignore[no-untyped-def]
        paper = service.set_done(paper_id, done)
        if request.headers.get("X-Requested-With") == "MyLibrary":
            return JSONResponse({"id": paper.id, "done": paper.is_done})
        destination = return_to if return_to and return_to.startswith("/") and not return_to.startswith("//") else f"/paper/{paper_id}"
        return RedirectResponse(destination, status_code=303)

    @app.post("/paper/{paper_id}/marker")
    async def set_paper_marker(paper_id: str, marker: str = Form("")):  # type: ignore[no-untyped-def]
        paper = service.set_marker(paper_id, marker)
        return JSONResponse({"id": paper.id, "marker": paper.marker, "done": paper.is_done})

    @app.post("/paper/{paper_id}/notes")
    async def set_paper_notes(paper_id: str, notes: str = Form("")):  # type: ignore[no-untyped-def]
        service.set_notes(paper_id, notes)
        return RedirectResponse(f"/paper/{paper_id}?message={quote_plus('Notes saved.')}", status_code=303)

    @app.post("/paper/{paper_id}/thumbnail-source")
    async def set_paper_thumbnail_source(request: Request, paper_id: str, source: str = Form(...)):  # type: ignore[no-untyped-def]
        paper = service.set_thumbnail_source(paper_id, source)
        if request.headers.get("X-Requested-With") == "MyLibrary":
            return JSONResponse({"id": paper.id, "thumbnail_source": paper.thumbnail_source})
        return RedirectResponse(f"/paper/{paper_id}?message={quote_plus('Timeline thumbnail saved.')}", status_code=303)

    @app.get("/api/papers")
    async def api_papers(q: str | None = None):  # type: ignore[no-untyped-def]
        return [{"id": p.id, "title": p.title, "authors": [a.author.name for a in p.authors], "year": p.year, "doi": p.doi, "arxiv_id": p.arxiv_id, "has_pdf": bool(p.files), "done": p.is_done, "marker": p.marker, "notes": p.notes, "thumbnail_source": p.thumbnail_source, "tags": [{"id": tag.id, "name": tag.name} for tag in p.tags], "citation_count": _citation_max(p.citations), "citations": {item.source: {"count": item.count, "updated_at": item.retrieved_at.isoformat()} for item in p.citations}, "thumbnail_url": f"/paper/{p.id}/thumbnail?source={p.thumbnail_source}&v={THUMBNAIL_VERSION}" if p.files else None, "figure_thumbnail_url": f"/paper/{p.id}/thumbnail?source=figure-1&v={THUMBNAIL_VERSION}" if p.files else None, "figure_2_thumbnail_url": f"/paper/{p.id}/thumbnail?source=figure-2&v={THUMBNAIL_VERSION}" if p.files else None, "figure_3_thumbnail_url": f"/paper/{p.id}/thumbnail?source=figure-3&v={THUMBNAIL_VERSION}" if p.files else None, "page_thumbnail_url": f"/paper/{p.id}/thumbnail?source=page-1&v={THUMBNAIL_VERSION}" if p.files else None, "added_at": p.latest_added_at.isoformat(), "first_added_at": p.created_at.isoformat(), "add_history": [event.added_at.isoformat() for event in reversed(p.add_events)], "updated_at": p.updated_at.isoformat()} for p in service.list_papers(q)]

    return app


def _lecture_file(settings: Settings, paper_id: str) -> Path:
    """Path to a paper's AI study-notes (讲义) markdown, if it has been created."""
    return settings.data_dir / "lectures" / f"{paper_id}.md"


def _card_sources(settings: Settings, service: LibraryService, paper) -> list[str]:  # type: ignore[no-untyped-def]
    """Ordered list of thumbnail sources that actually exist for a paper.

    The chosen timeline default leads; remaining figures then Page 1 follow.
    Missing sources are excluded so the card carousel never falls back to a
    duplicate Page 1 image.
    """
    if not paper.files:
        return []
    stored = paper.files[0]
    existing = [
        source
        for source in ("figure-1", "figure-2", "figure-3", "page-1")
        if settings.managed_path(service.files.thumbnail_relative_path(stored.sha256, source)).exists()
    ]
    default = paper.thumbnail_source or "figure-1"
    if default in existing:
        existing = [default] + [source for source in existing if source != default]
    return existing or ["page-1"]


def _author_summary(authorships) -> str:  # type: ignore[no-untyped-def]
    names = [authorship.author.name for authorship in authorships]
    if not names:
        return "Unknown authors"
    if len(names) <= 2:
        return ", ".join(names)
    return f"{names[0]}, …, {names[-1]}"


def _tag_style(name: str) -> str:
    """Return a stable, muted HSL palette derived only from tag text."""
    digest = hashlib.sha256(name.casefold().encode("utf-8")).digest()
    hue = int.from_bytes(digest[:2], "big") % 360
    saturation = 30 + digest[2] % 13
    return (
        f"--tag-bg:hsl({hue} {saturation}% 91%);"
        f"--tag-border:hsl({hue} {saturation}% 76%);"
        f"--tag-text:hsl({hue} {min(saturation + 8, 52)}% 32%)"
    )


def _citation_max(observations) -> int | None:  # type: ignore[no-untyped-def]
    return max((item.count for item in observations), default=None)


def _local_time(value: datetime) -> datetime:
    # SQLite returns naive datetimes even for timezone-aware columns. Stored
    # timestamps are UTC, so restore that context before presentation.
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(LOCAL_TIMEZONE)


def _timeline_day(value: datetime, today: date | None = None) -> str:
    local = _local_time(value)
    current = today or datetime.now(LOCAL_TIMEZONE).date()
    date_label = local.strftime("%A, %B %d, %Y")
    if local.date() == current:
        return f"Today · {date_label}"
    if local.date() == current - timedelta(days=1):
        return f"Yesterday · {date_label}"
    return date_label


def _utc_isoformat(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _annotation_json(annotation) -> dict:  # type: ignore[no-untyped-def]
    return {
        "id": annotation.id,
        "paper_id": annotation.paper_id,
        "target_type": annotation.target_type,
        "page_number": annotation.page_number,
        "selected_text": annotation.selected_text,
        "rects": json.loads(annotation.rects_json),
        "anchor": json.loads(annotation.anchor_json),
        "color": annotation.color,
        "note": annotation.note,
        "tags": [tag.name for tag in annotation.tags],
        "created_at": _utc_isoformat(annotation.created_at),
        "updated_at": _utc_isoformat(annotation.updated_at),
        "replies": [_annotation_reply_json(reply) for reply in annotation.replies],
    }


def _annotation_reply_json(reply) -> dict:  # type: ignore[no-untyped-def]
    return {
        "id": reply.id,
        "annotation_id": reply.annotation_id,
        "role": reply.role,
        "content": reply.content,
        "created_at": _utc_isoformat(reply.created_at),
    }
