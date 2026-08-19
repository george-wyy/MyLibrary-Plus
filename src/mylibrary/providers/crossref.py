from __future__ import annotations

import re
from datetime import date
from urllib.parse import unquote

from .base import MetadataProvider
from ..schemas import AuthorData, PaperCandidate


DOI_RE = re.compile(r"(?:doi:|https?://(?:dx\.)?doi\.org/)?(10\.\d{4,9}/\S+)$", re.I)


def extract_doi(value: str) -> str | None:
    match = DOI_RE.search(unquote(value.strip()))
    return match.group(1).rstrip(".,;)").lower() if match else None


class CrossrefProvider(MetadataProvider):
    name = "crossref"

    async def search(self, query: str, kind: str) -> list[PaperCandidate]:
        doi = extract_doi(query) if kind in {"doi", "url"} else None
        if doi:
            response = await self.client.get(f"https://api.crossref.org/works/{doi}")
            response.raise_for_status()
            items = [response.json()["message"]]
        else:
            response = await self.client.get(
                "https://api.crossref.org/works", params={"query.title": query, "rows": 8, "select": "DOI,title,author,abstract,published,container-title,volume,issue,page,type,URL,link"}
            )
            response.raise_for_status()
            items = response.json()["message"]["items"]
        return [self._parse(item) for item in items if item.get("title")]

    def _parse(self, item: dict) -> PaperCandidate:
        publication_date = _crossref_date(item.get("published"))
        authors = [
            AuthorData(
                name=" ".join(part for part in (author.get("given"), author.get("family")) if part),
                given_name=author.get("given"),
                family_name=author.get("family"),
                orcid=(author.get("ORCID") or "").rsplit("/", 1)[-1] or None,
            )
            for author in item.get("author", [])
        ]
        pdf_urls = [link["URL"] for link in item.get("link", []) if link.get("content-type") == "application/pdf"]
        doi = item.get("DOI", "").lower() or None
        return PaperCandidate(
            title=item["title"][0], source=self.name, authors=authors,
            abstract=_strip_jats(item.get("abstract")), year=publication_date.year if publication_date else None,
            publication_date=publication_date, venue=_first(item.get("container-title")),
            volume=item.get("volume"), issue=item.get("issue"), pages=item.get("page"),
            paper_type=item.get("type"), doi=doi, canonical_url=item.get("URL"),
            pdf_urls=pdf_urls, identifiers={"doi": doi} if doi else {}, raw=item,
        )


def _crossref_date(value: dict | None) -> date | None:
    parts = (value or {}).get("date-parts", [[]])[0]
    if not parts:
        return None
    try:
        return date(parts[0], parts[1] if len(parts) > 1 else 1, parts[2] if len(parts) > 2 else 1)
    except (TypeError, ValueError):
        return None


def _first(value: list | None) -> str | None:
    return value[0] if value else None


def _strip_jats(value: str | None) -> str | None:
    return re.sub(r"<[^>]+>", "", value).strip() if value else None

