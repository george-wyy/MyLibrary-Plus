from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import date
from urllib.parse import quote_plus

from .base import MetadataProvider
from ..schemas import AuthorData, PaperCandidate


ARXIV_ID_RE = re.compile(r"(?:arxiv:|arxiv\.org/(?:abs|pdf)/)([\w.\-/]+?)(?:\.pdf)?$", re.I)
ATOM = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def extract_arxiv_id(value: str) -> str | None:
    match = ARXIV_ID_RE.search(value.strip())
    return re.sub(r"v\d+$", "", match.group(1)) if match else None


class ArxivProvider(MetadataProvider):
    name = "arxiv"

    async def search(self, query: str, kind: str) -> list[PaperCandidate]:
        arxiv_id = extract_arxiv_id(query) if kind in {"arxiv", "url"} else None
        if arxiv_id:
            expression = f"id_list={quote_plus(arxiv_id)}"
        else:
            title_query = f'ti:"{query}"'
            expression = f"search_query={quote_plus(title_query)}&max_results=8"
        response = await self.client.get(f"https://export.arxiv.org/api/query?{expression}")
        response.raise_for_status()
        root = ET.fromstring(response.text)
        return [self._parse_entry(entry) for entry in root.findall("a:entry", ATOM)]

    def _parse_entry(self, entry: ET.Element) -> PaperCandidate:
        record_url = _text(entry, "a:id")
        versioned_arxiv_id = record_url.rstrip("/").rsplit("/", 1)[-1]
        arxiv_id = re.sub(r"v\d+$", "", versioned_arxiv_id)
        published = _text(entry, "a:published")
        publication_date = _date(published)
        authors = []
        for author in entry.findall("a:author", ATOM):
            name = _text(author, "a:name")
            authors.append(AuthorData(name=name))
        pdf_urls = [
            link.attrib["href"]
            for link in entry.findall("a:link", ATOM)
            if link.attrib.get("type") == "application/pdf" and link.attrib.get("href")
        ]
        journal_ref = _text(entry, "arxiv:journal_ref", required=False)
        doi = _text(entry, "arxiv:doi", required=False)
        return PaperCandidate(
            title=_clean(_text(entry, "a:title")),
            source=self.name,
            authors=authors,
            abstract=_clean(_text(entry, "a:summary")),
            year=publication_date.year if publication_date else None,
            publication_date=publication_date,
            venue=journal_ref,
            paper_type="preprint",
            doi=doi.lower() if doi else None,
            arxiv_id=arxiv_id,
            canonical_url=record_url,
            pdf_urls=pdf_urls or [f"https://arxiv.org/pdf/{versioned_arxiv_id}"],
            identifiers={"arxiv": arxiv_id},
            raw={"atom": ET.tostring(entry, encoding="unicode")},
        )


def _text(element: ET.Element, path: str, required: bool = True) -> str | None:
    child = element.find(path, ATOM)
    if child is not None and child.text:
        return child.text.strip()
    if required:
        return ""
    return None


def _clean(value: str | None) -> str:
    return " ".join((value or "").split())


def _date(value: str | None) -> date | None:
    try:
        return date.fromisoformat((value or "")[:10])
    except ValueError:
        return None
