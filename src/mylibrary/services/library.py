from __future__ import annotations

import json

import httpx
from sqlalchemy import func, or_, select
from sqlalchemy import update as sa_update
from sqlalchemy.orm import Session, selectinload, sessionmaker

from ..config import Settings
from ..db import create_db_engine, initialize_database, session_factory
from ..models import Annotation, AnnotationReply, Author, CitationObservation, Identifier, Paper, PaperAddEvent, PaperAuthor, StoredFile, Tag, paper_tags, utcnow
from ..providers.openreview import extract_openreview_id
from ..schemas import AddResult, PaperCandidate
from .discovery import DiscoveryService
from .files import FileService
from .matching import normalize_title


ANNOTATION_COLORS = {"yellow", "red", "green", "blue", "purple", "pink", "orange", "gray"}


def _normalize_tag_name(name: str) -> tuple[str, str]:
    clean_name = " ".join(name.split()).strip()
    if not clean_name:
        raise ValueError("Tag name cannot be empty")
    if len(clean_name) > 100:
        raise ValueError("Tag name cannot exceed 100 characters")
    return clean_name, clean_name.casefold()


class _OmittedField:
    pass


_OMITTED = _OmittedField()


class LibraryService:
    MARKERS = {"", "thumbup", "thumbdown", "star", "question", "check", "wrong"}
    THUMBNAIL_SOURCES = {"page-1", "figure-1", "figure-2", "figure-3"}

    def __init__(
        self,
        settings: Settings,
        metadata_transport: httpx.AsyncBaseTransport | None = None,
        file_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.engine = create_db_engine(settings)
        initialize_database(self.engine)
        self.sessions: sessionmaker[Session] = session_factory(self.engine)
        self.discovery = DiscoveryService(settings, metadata_transport)
        self.files = FileService(settings, file_transport)

    async def candidates(self, query: str, author: str | None = None, year: int | None = None) -> list[PaperCandidate]:
        return await self.discovery.discover(query, author, year)

    async def add(
        self,
        query: str,
        *,
        candidate_index: int | None = None,
        author: str | None = None,
        year: int | None = None,
        download_pdf: bool = True,
        auto_threshold: float = 0.86,
    ) -> AddResult:
        openreview_id = extract_openreview_id(query)
        if openreview_id:
            existing = self._paper_by_identifier("openreview", openreview_id)
            if existing:
                with self.sessions.begin() as session:
                    session.add(PaperAddEvent(paper_id=existing.id, added_at=utcnow()))
                return AddResult(
                    existing.id, False, existing.title, bool(existing.files),
                    f"Re-added {existing.title}.",
                )
        candidates = await self.candidates(query, author, year)
        if not candidates:
            raise LookupError(f"No metadata candidates found for: {query}")
        if candidate_index is None:
            if candidates[0].score < auto_threshold:
                raise AmbiguousMatch(candidates)
            candidate = candidates[0]
        else:
            try:
                candidate = candidates[candidate_index]
            except IndexError as error:
                raise ValueError("Candidate index is out of range") from error
        return await self.add_candidate(candidate, download_pdf=download_pdf)

    def _paper_by_identifier(self, scheme: str, value: str) -> Paper | None:
        statement = select(Paper).join(Identifier).where(
            Identifier.scheme == scheme,
            Identifier.value == value,
        ).options(selectinload(Paper.files))
        with self.sessions() as session:
            return session.scalar(statement)

    async def add_candidate(self, candidate: PaperCandidate, *, download_pdf: bool = True) -> AddResult:
        downloaded = await self.files.download_pdf(candidate.pdf_urls) if download_pdf and candidate.pdf_urls else None
        if downloaded:
            await self.files.create_thumbnails(downloaded.relative_path, downloaded.sha256, arxiv_id=candidate.arxiv_id, source_url=downloaded.source_url)
        with self.sessions.begin() as session:
            paper = self._find_existing(session, candidate)
            created = paper is None
            if paper is None:
                paper = self._new_paper(candidate)
                session.add(paper)
                session.flush()
                self._set_authors(session, paper, candidate)
            else:
                self._enrich(paper, candidate)
            self._set_identifiers(paper, candidate)
            if downloaded and not any(item.sha256 == downloaded.sha256 for item in paper.files):
                paper.files.append(StoredFile(
                    relative_path=downloaded.relative_path, sha256=downloaded.sha256,
                    size_bytes=downloaded.size_bytes, source_url=downloaded.source_url,
                    mime_type="application/pdf", is_primary=True,
                ))
            session.add(PaperAddEvent(
                paper_id=paper.id,
                added_at=paper.created_at if created else utcnow(),
            ))
            session.flush()
            paper_id, title = paper.id, paper.title
        action = "Added" if created else "Re-added"
        suffix = " and downloaded its PDF" if downloaded else ""
        return AddResult(paper_id, created, title, downloaded is not None, f"{action} {title}{suffix}.")

    def list_papers(self, query: str | None = None, tag_id: int | None = None) -> list[Paper]:
        latest_add = select(func.max(PaperAddEvent.added_at)).where(PaperAddEvent.paper_id == Paper.id).scalar_subquery()
        statement = select(Paper).options(selectinload(Paper.authors).selectinload(PaperAuthor.author), selectinload(Paper.files), selectinload(Paper.tags), selectinload(Paper.identifiers), selectinload(Paper.citations), selectinload(Paper.add_events))
        if query:
            pattern = f"%{query}%"
            statement = statement.where(or_(Paper.title.ilike(pattern), Paper.abstract.ilike(pattern), Paper.venue.ilike(pattern), Paper.notes.ilike(pattern)))
        if tag_id is not None:
            statement = statement.join(paper_tags).where(paper_tags.c.tag_id == tag_id)
        statement = statement.order_by(latest_add.desc(), Paper.created_at.desc())
        with self.sessions() as session:
            return list(session.scalars(statement).unique())

    def get_paper(self, paper_id: str) -> Paper | None:
        statement = select(Paper).where(Paper.id == paper_id).options(
            selectinload(Paper.authors).selectinload(PaperAuthor.author),
            selectinload(Paper.identifiers), selectinload(Paper.files), selectinload(Paper.tags), selectinload(Paper.citations), selectinload(Paper.add_events),
        )
        with self.sessions() as session:
            return session.scalar(statement)

    async def fetch_pdf(self, paper_id: str) -> bool:
        paper = self.get_paper(paper_id)
        if paper is None:
            raise LookupError("Paper not found")
        candidates = await self.candidates(paper.doi or paper.arxiv_id or paper.title)
        if not candidates:
            return False
        downloaded = await self.files.download_pdf(candidates[0].pdf_urls)
        if not downloaded:
            return False
        await self.files.create_thumbnails(downloaded.relative_path, downloaded.sha256, arxiv_id=candidates[0].arxiv_id, source_url=downloaded.source_url)
        with self.sessions.begin() as session:
            managed = session.get(Paper, paper_id)
            assert managed is not None
            if not any(item.sha256 == downloaded.sha256 for item in managed.files):
                managed.files.append(StoredFile(
                    relative_path=downloaded.relative_path, sha256=downloaded.sha256,
                    size_bytes=downloaded.size_bytes, source_url=downloaded.source_url,
                ))
        return True

    def list_tags(self) -> list[tuple[Tag, int]]:
        statement = (
            select(Tag, func.count(paper_tags.c.paper_id))
            .join(paper_tags, Tag.id == paper_tags.c.tag_id)
            .group_by(Tag.id)
            .order_by(Tag.name)
        )
        with self.sessions() as session:
            return list(session.execute(statement).all())

    def get_tag(self, tag_id: int) -> Tag | None:
        with self.sessions() as session:
            return session.get(Tag, tag_id)

    def add_tag(self, paper_id: str, name: str) -> Tag:
        clean_name, normalized = _normalize_tag_name(name)
        with self.sessions.begin() as session:
            paper = session.get(Paper, paper_id, options=[selectinload(Paper.tags)])
            if paper is None:
                raise LookupError("Paper not found")
            tag = session.scalar(select(Tag).where(Tag.normalized_name == normalized))
            if tag is None:
                tag = Tag(name=clean_name, normalized_name=normalized)
                session.add(tag)
                session.flush()
            if tag not in paper.tags:
                paper.tags.append(tag)
                paper.updated_at = utcnow()
            session.flush()
            session.expunge(tag)
            return tag

    def remove_tag(self, paper_id: str, tag_id: int) -> None:
        with self.sessions.begin() as session:
            paper = session.get(Paper, paper_id, options=[selectinload(Paper.tags)])
            if paper is None:
                raise LookupError("Paper not found")
            paper.tags[:] = [tag for tag in paper.tags if tag.id != tag_id]
            paper.updated_at = utcnow()

    def set_done(self, paper_id: str, done: bool) -> Paper:
        with self.sessions.begin() as session:
            paper = session.get(Paper, paper_id)
            if paper is None:
                raise LookupError("Paper not found")
            paper.is_done = done
            if done:
                paper.marker = "check"
            elif paper.marker == "check":
                paper.marker = None
            session.flush()
            session.expunge(paper)
            return paper

    def set_marker(self, paper_id: str, marker: str) -> Paper:
        if marker not in self.MARKERS:
            raise ValueError("Unknown paper marker")
        with self.sessions.begin() as session:
            paper = session.get(Paper, paper_id)
            if paper is None:
                raise LookupError("Paper not found")
            paper.marker = marker or None
            paper.is_done = marker == "check"
            session.flush()
            session.expunge(paper)
            return paper

    def set_notes(self, paper_id: str, notes: str) -> Paper:
        with self.sessions.begin() as session:
            paper = session.get(Paper, paper_id)
            if paper is None:
                raise LookupError("Paper not found")
            paper.notes = notes.strip() or None
            session.flush()
            session.expunge(paper)
            return paper

    def set_thumbnail_source(self, paper_id: str, source: str) -> Paper:
        if source not in self.THUMBNAIL_SOURCES:
            raise ValueError("Unknown thumbnail source")
        with self.sessions.begin() as session:
            paper = session.get(Paper, paper_id)
            if paper is None:
                raise LookupError("Paper not found")
            paper.thumbnail_source = source
            session.flush()
            session.expunge(paper)
            return paper

    def list_annotations(self, paper_id: str) -> list[Annotation]:
        with self.sessions() as session:
            return list(session.scalars(
                select(Annotation)
                .where(Annotation.paper_id == paper_id)
                .options(selectinload(Annotation.replies), selectinload(Annotation.tags))
                .order_by(Annotation.created_at)
            ))

    def list_all_annotations(self) -> list[Annotation]:
        with self.sessions() as session:
            return list(session.scalars(
                select(Annotation)
                .options(
                    selectinload(Annotation.replies),
                    selectinload(Annotation.tags),
                    selectinload(Annotation.paper),
                )
                .order_by(Annotation.created_at)
            ))

    def list_note_annotations(self, slug: str) -> list[Annotation]:
        """All annotations attached to a shared concept note (across papers)."""
        with self.sessions() as session:
            rows = session.scalars(
                select(Annotation)
                .where(Annotation.target_type == "note")
                .options(
                    selectinload(Annotation.replies),
                    selectinload(Annotation.tags),
                    selectinload(Annotation.paper),
                )
                .order_by(Annotation.created_at)
            )
            result = []
            for annotation in rows:
                try:
                    if json.loads(annotation.anchor_json).get("note_slug") == slug:
                        result.append(annotation)
                except (ValueError, TypeError):
                    continue
            return result

    def add_annotation(
        self,
        paper_id: str,
        page_number: int,
        selected_text: str,
        rects: list[dict[str, float]],
        color: str = "yellow",
        note: str | None = None,
        *,
        target_type: str = "pdf",
        anchor: dict | None = None,
        tags: list[str] | None = None,
    ) -> Annotation:
        target_type = target_type.strip().lower()
        if target_type not in {"pdf", "lecture", "note"}:
            raise ValueError("Annotation target must be pdf, lecture, or note")
        clean_text = selected_text.strip()
        if not clean_text:
            raise ValueError("Selected text is required")
        if color not in ANNOTATION_COLORS:
            raise ValueError("Unknown highlight color")
        normalized = []
        normalized_anchor: dict = {"exact": clean_text}
        if target_type == "pdf":
            if page_number < 1 or not rects:
                raise ValueError("A page and highlight rectangles are required for PDF annotations")
            for rect in rects:
                try:
                    values = {key: float(rect[key]) for key in ("x", "y", "width", "height")}
                except (KeyError, TypeError, ValueError) as error:
                    raise ValueError("Invalid highlight rectangle") from error
                if any(value < 0 or value > 1 for value in values.values()) or values["width"] <= 0 or values["height"] <= 0:
                    raise ValueError("Invalid highlight rectangle")
                if values["x"] + values["width"] > 1.01 or values["y"] + values["height"] > 1.01:
                    raise ValueError("Highlight rectangle is outside the page")
                normalized.append(values)
        else:
            page_number = 0
            anchor = anchor if isinstance(anchor, dict) else {}
            try:
                start, end = int(anchor["start"]), int(anchor["end"])
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError("Lecture annotations require start and end text offsets") from error
            if start < 0 or end <= start:
                raise ValueError("Invalid lecture text offsets")
            normalized_anchor = {
                "exact": clean_text,
                "prefix": str(anchor.get("prefix", ""))[-200:],
                "suffix": str(anchor.get("suffix", ""))[:200],
                "start": start,
                "end": end,
            }
            if target_type == "note":
                note_slug = "".join(ch for ch in str(anchor.get("note_slug", "")).strip() if ch.isalnum() or ch in "-_")
                if not note_slug:
                    raise ValueError("Note annotations require a note_slug")
                normalized_anchor["note_slug"] = note_slug
            if target_type == "lecture":
                # A paper can carry several lectures; the slug says which one this
                # highlight belongs to. Absent/"" means the paper's main lecture,
                # which is what every annotation made before multi-lecture support
                # already is, so old records need no migration.
                lecture_slug = "".join(ch for ch in str(anchor.get("lecture_slug", "")).strip() if ch.isalnum() or ch in "-_")
                if lecture_slug:
                    normalized_anchor["lecture_slug"] = lecture_slug
        with self.sessions.begin() as session:
            if session.get(Paper, paper_id) is None:
                raise LookupError("Paper not found")
            clean_tags = self._normalize_annotation_tags(tags if tags is not None else [])
            annotation = Annotation(
                paper_id=paper_id,
                target_type=target_type,
                page_number=page_number,
                selected_text=clean_text[:20_000],
                rects_json=json.dumps(normalized),
                anchor_json=json.dumps(normalized_anchor, ensure_ascii=False),
                color=color,
                note=(note or "").strip()[:10_000] or None,
            )
            session.add(annotation)
            session.flush()
            annotation.replies = []
            self._replace_annotation_tags(session, annotation, clean_tags)
            session.flush()
            session.expunge(annotation)
            return annotation

    def update_annotation(
        self,
        paper_id: str,
        annotation_id: str,
        *,
        note: str | None | _OmittedField = _OMITTED,
        color: str | _OmittedField = _OMITTED,
        tags: list[str] | _OmittedField = _OMITTED,
        is_favorite: bool | _OmittedField = _OMITTED,
    ) -> Annotation:
        with self.sessions.begin() as session:
            annotation = session.get(
                Annotation,
                annotation_id,
                options=[selectinload(Annotation.replies), selectinload(Annotation.tags)],
            )
            if annotation is None or annotation.paper_id != paper_id:
                raise LookupError("Annotation not found")
            if note is not _OMITTED:
                if note is not None and not isinstance(note, str):
                    raise ValueError("Annotation note must be a string or null")
                annotation.note = (note or "").strip()[:10_000] or None
            if color is not _OMITTED:
                if color not in ANNOTATION_COLORS:
                    raise ValueError("Unknown highlight color")
                annotation.color = color
            if tags is not _OMITTED:
                clean_tags = self._normalize_annotation_tags(tags)
                self._replace_annotation_tags(session, annotation, clean_tags)
            if is_favorite is not _OMITTED:
                if not isinstance(is_favorite, bool):
                    raise ValueError("is_favorite must be a boolean")
                annotation.is_favorite = is_favorite
            session.flush()
            session.expunge(annotation)
            return annotation

    def mark_annotation_viewed(self, paper_id: str, annotation_id: str) -> Annotation:
        """Record that the reader opened this annotation's thread (a WeChat-style
        read receipt for AI replies). Uses a targeted UPDATE rather than the usual
        load-mutate-flush pattern, and re-asserts updated_at's own current value to
        override its onupdate=utcnow default - otherwise merely viewing a thread
        would bump "updated" and make an untouched annotation look freshly edited.
        """
        with self.sessions.begin() as session:
            annotation = session.get(
                Annotation,
                annotation_id,
                options=[selectinload(Annotation.replies), selectinload(Annotation.tags)],
            )
            if annotation is None or annotation.paper_id != paper_id:
                raise LookupError("Annotation not found")
            session.execute(
                sa_update(Annotation)
                .where(Annotation.id == annotation_id)
                .values(last_viewed_at=utcnow(), updated_at=Annotation.updated_at)
            )
            session.flush()
            session.refresh(annotation)
            session.expunge(annotation)
            return annotation

    def set_annotation_tags(self, paper_id: str, annotation_id: str, names: list[str]) -> Annotation:
        return self.update_annotation(paper_id, annotation_id, tags=names)

    @staticmethod
    def _normalize_annotation_tags(names: object) -> dict[str, str]:
        if not isinstance(names, list):
            raise ValueError("Annotation tags must be an array of strings")
        clean_names: dict[str, str] = {}
        for name in names:
            if not isinstance(name, str):
                raise ValueError("Annotation tags must be an array of strings")
            clean_name, normalized = _normalize_tag_name(name)
            clean_names.setdefault(normalized, clean_name)
        if len(clean_names) > 20:
            raise ValueError("An annotation cannot have more than 20 tags")
        return clean_names

    @staticmethod
    def _replace_annotation_tags(
        session: Session,
        annotation: Annotation,
        clean_names: dict[str, str],
    ) -> None:
        tags_by_name = {
            tag.normalized_name: tag
            for tag in session.scalars(select(Tag).where(Tag.normalized_name.in_(clean_names)))
        }
        for normalized, clean_name in clean_names.items():
            if normalized not in tags_by_name:
                tag = Tag(name=clean_name, normalized_name=normalized)
                session.add(tag)
                tags_by_name[normalized] = tag

        if {tag.normalized_name for tag in annotation.tags} != set(clean_names):
            annotation.tags = sorted(tags_by_name.values(), key=lambda tag: tag.name)
            annotation.updated_at = utcnow()

    def list_annotation_tags(self) -> list[Tag]:
        with self.sessions() as session:
            return list(session.scalars(select(Tag).order_by(Tag.name, Tag.id)))

    def add_annotation_reply(
        self,
        paper_id: str,
        annotation_id: str,
        content: str,
        role: str = "user",
    ) -> AnnotationReply:
        clean_content = content.strip()
        clean_role = role.strip().lower()
        if not clean_content:
            raise ValueError("Reply content cannot be empty")
        if clean_role not in {"user", "assistant"}:
            raise ValueError("Reply role must be user or assistant")
        with self.sessions.begin() as session:
            annotation = session.get(Annotation, annotation_id)
            if annotation is None or annotation.paper_id != paper_id:
                raise LookupError("Annotation not found")
            reply = AnnotationReply(
                annotation_id=annotation.id,
                role=clean_role,
                content=clean_content[:10_000],
            )
            annotation.updated_at = utcnow()
            session.add(reply)
            session.flush()
            session.expunge(reply)
            return reply

    def delete_annotation(self, paper_id: str, annotation_id: str) -> None:
        with self.sessions.begin() as session:
            annotation = session.get(Annotation, annotation_id)
            if annotation is None or annotation.paper_id != paper_id:
                raise LookupError("Annotation not found")
            session.delete(annotation)

    async def update_citations(self, paper_ids: list[str] | None = None) -> list[CitationObservation]:
        from .citations import CitationService

        papers = self.list_papers()
        if paper_ids is not None:
            selected_ids = set(paper_ids)
            papers = [paper for paper in papers if paper.id in selected_ids]
        else:
            selected_ids = {paper.id for paper in papers}
        results = await CitationService(self.settings).fetch(papers)
        checked_at = utcnow()
        with self.sessions.begin() as session:
            for result in results:
                observation = session.scalar(select(CitationObservation).where(
                    CitationObservation.paper_id == result.paper_id,
                    CitationObservation.source == result.source,
                ))
                if observation is None:
                    observation = CitationObservation(paper_id=result.paper_id, source=result.source, count=result.count)
                    session.add(observation)
                observation.count = result.count
                observation.provider_work_id = result.provider_work_id
                observation.retrieved_at = result.retrieved_at
            if selected_ids:
                for paper in session.scalars(select(Paper).where(Paper.id.in_(selected_ids))):
                    paper.citation_checked_at = checked_at
        return [
            observation
            for paper in self.list_papers()
            if paper.id in selected_ids
            for observation in paper.citations
        ]

    async def generate_thumbnails(self, *, force: bool = False) -> tuple[int, int]:
        """Backfill missing thumbnails. Returns (generated, total PDFs)."""
        papers = self.list_papers()
        files = [(paper, stored) for paper in papers for stored in paper.files]
        generated = 0
        for paper, stored in files:
            expected = [self.settings.managed_path(self.files.thumbnail_relative_path(stored.sha256, source)) for source in self.THUMBNAIL_SOURCES]
            if force or any(not path.exists() for path in expected):
                await self.files.create_thumbnails(stored.relative_path, stored.sha256, force=force, arxiv_id=paper.arxiv_id, source_url=stored.source_url)
                generated += 1
        return generated, len(files)

    def _find_existing(self, session: Session, candidate: PaperCandidate) -> Paper | None:
        for scheme, value in candidate.identifiers.items():
            if value:
                found = session.scalar(
                    select(Paper).join(Identifier).where(
                        Identifier.scheme == scheme,
                        Identifier.value == value,
                    ).options(selectinload(Paper.files))
                )
                if found:
                    return found
        checks = []
        if candidate.doi:
            checks.append(Paper.doi == candidate.doi)
        if candidate.arxiv_id:
            checks.append(Paper.arxiv_id == candidate.arxiv_id)
        if candidate.pmid:
            checks.append(Paper.pmid == candidate.pmid)
        if checks:
            found = session.scalar(select(Paper).where(or_(*checks)).options(selectinload(Paper.files)))
            if found:
                return found
        statement = select(Paper).where(Paper.normalized_title == normalize_title(candidate.title))
        if candidate.year:
            statement = statement.where(or_(Paper.year == candidate.year, Paper.year.is_(None)))
        return session.scalar(statement.options(selectinload(Paper.files)))

    def _new_paper(self, candidate: PaperCandidate) -> Paper:
        added_at = utcnow()
        return Paper(
            title=candidate.title, normalized_title=normalize_title(candidate.title), abstract=candidate.abstract,
            year=candidate.year, publication_date=candidate.publication_date, venue=candidate.venue,
            volume=candidate.volume, issue=candidate.issue, pages=candidate.pages, paper_type=candidate.paper_type,
            doi=candidate.doi, arxiv_id=candidate.arxiv_id, pmid=candidate.pmid,
            canonical_url=candidate.canonical_url, metadata_source=candidate.source,
            metadata_raw=json.dumps(candidate.raw, ensure_ascii=False, default=str),
            provenance=json.dumps({"sources": candidate.sources}, ensure_ascii=False),
            created_at=added_at, updated_at=added_at,
        )

    def _set_authors(self, session: Session, paper: Paper, candidate: PaperCandidate) -> None:
        for position, data in enumerate(candidate.authors):
            author = None
            if data.orcid:
                author = session.scalar(select(Author).where(Author.orcid == data.orcid))
            if author is None:
                author = Author(name=data.name, given_name=data.given_name, family_name=data.family_name, orcid=data.orcid)
                session.add(author)
                session.flush()
            paper.authors.append(PaperAuthor(author=author, position=position))

    def _set_identifiers(self, paper: Paper, candidate: PaperCandidate) -> None:
        existing = {(identifier.scheme, identifier.value) for identifier in paper.identifiers}
        for scheme, value in candidate.identifiers.items():
            if value and (scheme, value) not in existing:
                paper.identifiers.append(Identifier(scheme=scheme, value=value))
                existing.add((scheme, value))

    def _enrich(self, paper: Paper, candidate: PaperCandidate) -> None:
        for field in ("abstract", "publication_date", "year", "venue", "volume", "issue", "pages", "paper_type", "doi", "arxiv_id", "pmid", "canonical_url"):
            if not getattr(paper, field) and getattr(candidate, field):
                setattr(paper, field, getattr(candidate, field))
        paper.provenance = json.dumps({"sources": candidate.sources}, ensure_ascii=False)


class AmbiguousMatch(LookupError):
    def __init__(self, candidates: list[PaperCandidate]) -> None:
        super().__init__("Multiple or low-confidence metadata candidates found")
        self.candidates = candidates
