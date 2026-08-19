from __future__ import annotations

from html.parser import HTMLParser
from urllib.parse import urljoin

from .base import MetadataProvider
from .crossref import extract_doi
from ..schemas import AuthorData, PaperCandidate


class _MetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.values: dict[str, list[str]] = {}
        self.title_parts: list[str] = []
        self.in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "meta":
            key = values.get("name") or values.get("property")
            content = values.get("content")
            if key and content:
                self.values.setdefault(key.lower(), []).append(content.strip())

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)


class WebPageProvider(MetadataProvider):
    name = "webpage"

    async def search(self, query: str, kind: str) -> list[PaperCandidate]:
        if kind != "url" or not query.lower().startswith(("http://", "https://")):
            return []
        response = await self.client.get(query, follow_redirects=True)
        response.raise_for_status()
        if "html" not in response.headers.get("content-type", ""):
            return []
        parser = _MetadataParser()
        parser.feed(response.text)
        values = parser.values
        title = _one(values, "citation_title", "dc.title", "og:title") or " ".join(parser.title_parts).strip()
        if "/challenge" in response.url.path or "cf-turnstile" in response.text or title.casefold().startswith("verifying your browser"):
            raise LookupError("The site requires browser verification")
        if not title:
            return []
        author_names = values.get("citation_author", []) or values.get("dc.creator", [])
        doi = extract_doi(_one(values, "citation_doi", "dc.identifier") or "")
        pdf = _one(values, "citation_pdf_url")
        year = _year(_one(values, "citation_publication_date", "citation_date", "dc.date"))
        return [PaperCandidate(
            title=title, source=self.name, authors=[AuthorData(name=name) for name in author_names],
            abstract=_one(values, "citation_abstract", "description", "og:description"), year=year,
            venue=_one(values, "citation_journal_title", "citation_conference_title"),
            volume=_one(values, "citation_volume"), issue=_one(values, "citation_issue"),
            pages=_pages(values), doi=doi, canonical_url=str(response.url),
            pdf_urls=[urljoin(str(response.url), pdf)] if pdf else [],
            identifiers={"doi": doi} if doi else {}, raw={"meta": values},
        )]


def _one(values: dict[str, list[str]], *keys: str) -> str | None:
    for key in keys:
        if values.get(key):
            return values[key][0]
    return None


def _year(value: str | None) -> int | None:
    if value:
        for token in value.replace("/", "-").split("-"):
            if len(token) == 4 and token.isdigit():
                return int(token)
    return None


def _pages(values: dict[str, list[str]]) -> str | None:
    first = _one(values, "citation_firstpage")
    last = _one(values, "citation_lastpage")
    return f"{first}-{last}" if first and last else first
