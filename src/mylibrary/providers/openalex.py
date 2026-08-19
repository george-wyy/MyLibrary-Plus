from __future__ import annotations

from datetime import date
import re

from .base import MetadataProvider
from .crossref import extract_doi
from ..schemas import AuthorData, PaperCandidate


class OpenAlexProvider(MetadataProvider):
    name = "openalex"

    async def search(self, query: str, kind: str) -> list[PaperCandidate]:
        doi = extract_doi(query) if kind in {"doi", "url"} else None
        if doi:
            response = await self.client.get(f"https://api.openalex.org/works/https://doi.org/{doi}")
            response.raise_for_status()
            items = [response.json()]
        elif kind == "pmid" and (match := re.search(r"(\d+)", query)):
            response = await self.client.get(f"https://api.openalex.org/works/pmid:{match.group(1)}")
            response.raise_for_status()
            items = [response.json()]
        else:
            response = await self.client.get("https://api.openalex.org/works", params={"search": query, "per-page": 8})
            response.raise_for_status()
            items = response.json().get("results", [])
        return [self._parse(item) for item in items if item.get("title")]

    def _parse(self, item: dict) -> PaperCandidate:
        ids = item.get("ids") or {}
        doi = extract_doi(ids.get("doi", ""))
        arxiv_id = _last(ids.get("arxiv"))
        pmid = _last(ids.get("pmid"))
        authors = [
            AuthorData(
                name=authorship.get("author", {}).get("display_name", ""),
                orcid=_last(authorship.get("author", {}).get("orcid")),
            )
            for authorship in item.get("authorships", [])
            if authorship.get("author", {}).get("display_name")
        ]
        location = item.get("best_oa_location") or item.get("primary_location") or {}
        source = location.get("source") or {}
        pdf_url = location.get("pdf_url")
        publication_date = _date(item.get("publication_date"))
        return PaperCandidate(
            title=item["title"], source=self.name, authors=authors,
            abstract=_abstract(item.get("abstract_inverted_index")), year=item.get("publication_year"),
            publication_date=publication_date, venue=source.get("display_name"), paper_type=item.get("type"),
            doi=doi, arxiv_id=arxiv_id, pmid=pmid, canonical_url=location.get("landing_page_url") or ids.get("openalex"),
            pdf_urls=[pdf_url] if pdf_url else [],
            identifiers={key: value for key, value in {"openalex": _last(ids.get("openalex")), "doi": doi, "arxiv": arxiv_id, "pmid": pmid}.items() if value},
            raw=item,
        )


def _last(value: str | None) -> str | None:
    return value.rstrip("/").rsplit("/", 1)[-1] if value else None


def _date(value: str | None) -> date | None:
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        return None


def _abstract(index: dict[str, list[int]] | None) -> str | None:
    if not index:
        return None
    words = [(position, word) for word, positions in index.items() for position in positions]
    return " ".join(word for _, word in sorted(words))
