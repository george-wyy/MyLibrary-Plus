from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any


@dataclass
class AuthorData:
    name: str
    given_name: str | None = None
    family_name: str | None = None
    orcid: str | None = None


@dataclass
class PaperCandidate:
    title: str
    source: str
    authors: list[AuthorData] = field(default_factory=list)
    abstract: str | None = None
    year: int | None = None
    publication_date: date | None = None
    venue: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    paper_type: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    pmid: str | None = None
    canonical_url: str | None = None
    pdf_urls: list[str] = field(default_factory=list)
    identifiers: dict[str, str] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)
    score: float = 0.0
    sources: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.sources:
            self.sources = [self.source]


@dataclass
class AddResult:
    paper_id: str
    created: bool
    title: str
    pdf_downloaded: bool
    message: str
