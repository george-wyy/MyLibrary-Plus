from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

import httpx

from .base import MetadataProvider
from ..schemas import AuthorData, PaperCandidate


def extract_openreview_id(value: str) -> str | None:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"openreview.net", "www.openreview.net"}:
        return None
    paper_id = parse_qs(parsed.query).get("id", [""])[0].strip()
    return paper_id or None


class OpenReviewProvider(MetadataProvider):
    name = "openreview"

    async def search(self, query: str, kind: str) -> list[PaperCandidate]:
        paper_id = extract_openreview_id(query)
        if kind != "openreview" or not paper_id:
            return []
        last_error: Exception | None = None
        for api_url in ("https://api2.openreview.net/notes", "https://api.openreview.net/notes"):
            try:
                response = await self.client.get(api_url, params={"id": paper_id})
                response.raise_for_status()
                notes = response.json().get("notes", [])
                if notes:
                    return [self._parse(notes[0], paper_id)]
            except (httpx.HTTPError, ValueError, KeyError) as error:
                last_error = error
        if last_error:
            raise last_error
        return []

    def _parse(self, note: dict, paper_id: str) -> PaperCandidate:
        content = note.get("content") or {}
        title = str(_value(content.get("title")) or "").strip()
        if not title:
            raise ValueError("OpenReview record has no title")
        authors = _value(content.get("authors")) or []
        if isinstance(authors, str):
            authors = [authors]
        venue = _value(content.get("venue")) or _value(content.get("venueid"))
        publication_date = _timestamp_date(note.get("pdate") or note.get("odate") or note.get("cdate"))
        forum_url = f"https://openreview.net/forum?id={paper_id}"
        return PaperCandidate(
            title=title,
            source=self.name,
            authors=[AuthorData(name=str(author)) for author in authors],
            abstract=_text(_value(content.get("abstract"))),
            year=publication_date.year if publication_date else None,
            publication_date=publication_date,
            venue=_text(venue),
            paper_type="conference-paper",
            canonical_url=forum_url,
            pdf_urls=[f"https://openreview.net/pdf?id={paper_id}"],
            identifiers={"openreview": paper_id},
            raw=note,
        )


def _value(value):  # type: ignore[no-untyped-def]
    return value.get("value") if isinstance(value, dict) and "value" in value else value


def _text(value) -> str | None:  # type: ignore[no-untyped-def]
    return str(value).strip() if value is not None and str(value).strip() else None


def _timestamp_date(value):  # type: ignore[no-untyped-def]
    try:
        return datetime.fromtimestamp(int(value) / 1000, timezone.utc).date() if value else None
    except (TypeError, ValueError, OSError):
        return None
