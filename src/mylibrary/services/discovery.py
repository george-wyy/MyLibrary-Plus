from __future__ import annotations

import asyncio
import re
from urllib.parse import urlparse

import httpx

from ..config import Settings
from ..providers import ArxivProvider, CrossrefProvider, OpenAlexProvider, OpenReviewProvider, WebPageProvider
from ..providers.arxiv import extract_arxiv_id
from ..providers.crossref import extract_doi
from ..providers.openreview import extract_openreview_id
from ..schemas import PaperCandidate
from .matching import merge_candidates, score_candidate


PMID_RE = re.compile(r"(?:pmid:|pubmed\.ncbi\.nlm\.nih\.gov/)(\d+)", re.I)


def classify_input(value: str) -> str:
    value = value.strip()
    if extract_doi(value):
        return "doi"
    if extract_arxiv_id(value):
        return "arxiv"
    if extract_openreview_id(value):
        return "openreview"
    if PMID_RE.search(value):
        return "pmid"
    parsed = urlparse(value)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return "url"
    return "title"


class DiscoveryService:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.settings = settings
        self.transport = transport

    async def discover(self, query: str, author: str | None = None, year: int | None = None) -> list[PaperCandidate]:
        kind = classify_input(query)
        headers = {"User-Agent": self.settings.user_agent, "Accept": "application/json, application/atom+xml, text/html"}
        async with httpx.AsyncClient(timeout=self.settings.request_timeout, headers=headers, transport=self.transport, follow_redirects=True) as client:
            providers = {
                "arxiv": [ArxivProvider(client)],
                "doi": [CrossrefProvider(client), OpenAlexProvider(client)],
                "pmid": [OpenAlexProvider(client)],
                "openreview": [OpenReviewProvider(client)],
                "url": [WebPageProvider(client)],
                "title": [ArxivProvider(client), CrossrefProvider(client), OpenAlexProvider(client)],
            }[kind]
            results = await asyncio.gather(*(provider.search(query, kind) for provider in providers), return_exceptions=True)
        candidates = [candidate for result in results if isinstance(result, list) for candidate in result]
        merged = merge_candidates(candidates)
        scoring_query = query if kind == "title" else (merged[0].title if merged else query)
        for candidate in merged:
            candidate.score = score_candidate(scoring_query, candidate, author, year)
        return sorted(merged, key=lambda item: item.score, reverse=True)
