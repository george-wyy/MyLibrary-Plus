from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from ..config import Settings
from ..models import Paper
from .matching import normalize_title


DAILY_REFRESH_SECONDS = 24 * 60 * 60
STARTUP_REFRESH_DELAY_SECONDS = 10
NEW_PAPER_POLL_SECONDS = 15


@dataclass
class CitationResult:
    paper_id: str
    source: str
    count: int
    provider_work_id: str | None
    retrieved_at: datetime


class CitationService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def fetch(self, papers: list[Paper]) -> list[CitationResult]:
        headers = {"User-Agent": self.settings.user_agent}
        async with httpx.AsyncClient(timeout=self.settings.request_timeout, headers=headers, follow_redirects=True) as client:
            semantic, openalex, crossref = await asyncio.gather(
                self._semantic_scholar(client, papers),
                self._openalex(client, papers),
                self._crossref(client, papers),
                return_exceptions=True,
            )
        return [item for group in (semantic, openalex, crossref) if isinstance(group, list) for item in group]

    async def _semantic_scholar(self, client: httpx.AsyncClient, papers: list[Paper]) -> list[CitationResult]:
        identified = [(paper, f"ARXIV:{paper.arxiv_id}" if paper.arxiv_id else f"DOI:{paper.doi}" if paper.doi else None) for paper in papers]
        identified = [(paper, identifier) for paper, identifier in identified if identifier]
        if not identified:
            return []
        response = None
        for attempt, delay in enumerate((2, 5, 10, 0)):
            response = await client.post(
                "https://api.semanticscholar.org/graph/v1/paper/batch",
                params={"fields": "title,citationCount,externalIds"},
                json={"ids": [identifier for _, identifier in identified]},
            )
            if response.status_code != 429 or attempt == 3:
                break
            retry_after = response.headers.get("retry-after")
            await asyncio.sleep(float(retry_after) if retry_after else delay)
        assert response is not None
        response.raise_for_status()
        now = datetime.now(timezone.utc)
        results = []
        for (paper, _), record in zip(identified, response.json(), strict=False):
            if record and record.get("citationCount") is not None:
                results.append(CitationResult(paper.id, "semantic_scholar", int(record["citationCount"]), record.get("paperId"), now))
        return results

    async def _openalex(self, client: httpx.AsyncClient, papers: list[Paper]) -> list[CitationResult]:
        now = datetime.now(timezone.utc)

        async def lookup(paper: Paper) -> CitationResult | None:
            openalex_id = next((item.value for item in paper.identifiers if item.scheme == "openalex"), None)
            if openalex_id:
                response = await client.get(f"https://api.openalex.org/works/{quote(openalex_id, safe='')}")
                if response.status_code == 200:
                    record = response.json()
                    return CitationResult(paper.id, "openalex", int(record.get("cited_by_count", 0)), record.get("id"), now)
            response = await client.get("https://api.openalex.org/works", params={"search": paper.title, "per-page": 5, "select": "id,title,publication_year,cited_by_count"})
            response.raise_for_status()
            for record in response.json().get("results", []):
                if normalize_title(record.get("title", "")) == paper.normalized_title and (
                    not paper.year or not record.get("publication_year") or abs(paper.year - int(record["publication_year"])) <= 1
                ):
                    return CitationResult(paper.id, "openalex", int(record.get("cited_by_count", 0)), record.get("id"), now)
            return None

        fetched = await asyncio.gather(*(lookup(paper) for paper in papers), return_exceptions=True)
        return [item for item in fetched if isinstance(item, CitationResult)]

    async def _crossref(self, client: httpx.AsyncClient, papers: list[Paper]) -> list[CitationResult]:
        now = datetime.now(timezone.utc)

        async def lookup(paper: Paper) -> CitationResult | None:
            if not paper.doi:
                return None
            response = await client.get(f"https://api.crossref.org/works/{quote(paper.doi, safe='')}")
            if response.status_code != 200:
                return None
            record = response.json().get("message", {})
            count = record.get("is-referenced-by-count")
            return CitationResult(paper.id, "crossref", int(count), record.get("DOI"), now) if count is not None else None

        fetched = await asyncio.gather(*(lookup(paper) for paper in papers), return_exceptions=True)
        return [item for item in fetched if isinstance(item, CitationResult)]


class DailyCitationUpdater:
    """Refresh citation observations daily without blocking the application."""

    def __init__(self, library: Any, settings: Settings) -> None:
        self.library = library
        self.settings = settings
        self.state_path = settings.data_dir / "citation-state.json"
        self.log_path = settings.logs_dir / "citations.log"
        self.logger = _citation_logger(self.log_path)

    async def run(self) -> None:
        if self._load_attempt() is None:
            await asyncio.sleep(STARTUP_REFRESH_DELAY_SECONDS)
            await self._refresh_all()
        while True:
            pending = [paper.id for paper in self.library.list_papers() if paper.citation_checked_at is None]
            if pending:
                await self._refresh(pending, "new_papers")
                await asyncio.sleep(NEW_PAPER_POLL_SECONDS)
                continue
            delay = self.seconds_until_due()
            if delay <= 0:
                await self._refresh_all()
                continue
            await asyncio.sleep(min(delay, NEW_PAPER_POLL_SECONDS))

    async def _refresh_all(self) -> None:
        attempted_at = datetime.now(timezone.utc)
        await self._refresh(None, "daily")
        self._save_attempt(attempted_at)

    async def _refresh(self, paper_ids: list[str] | None, reason: str) -> None:
        try:
            observations = await self.library.update_citations(paper_ids)
            count = len(paper_ids) if paper_ids is not None else len(self.library.list_papers())
            self.logger.info(
                "refresh_finished reason=%s papers=%s observations=%s",
                reason, count, len(observations),
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            # Citation providers are optional external services. A failed
            # refresh must never stop the web server or Telegram bot.
            self.logger.exception("refresh_failed reason=%s", reason)

    def seconds_until_due(self, now: datetime | None = None) -> float:
        last_attempt = self._load_attempt()
        if last_attempt is None:
            return STARTUP_REFRESH_DELAY_SECONDS
        current = now or datetime.now(timezone.utc)
        return max(0.0, DAILY_REFRESH_SECONDS - (current - last_attempt).total_seconds())

    def _load_attempt(self) -> datetime | None:
        try:
            value = json.loads(self.state_path.read_text(encoding="utf-8"))["last_attempt"]
            parsed = datetime.fromisoformat(value)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            return None

    def _save_attempt(self, attempted_at: datetime) -> None:
        self.settings.initialize()
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"last_attempt": attempted_at.isoformat()}), encoding="utf-8")
        temporary.replace(self.state_path)


def _citation_logger(path: Path) -> logging.Logger:
    path.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(f"mylibrary.citations.{path.resolve()}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        handler = RotatingFileHandler(path, maxBytes=2_000_000, backupCount=2, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%dT%H:%M:%S%z"))
        logger.addHandler(handler)
    return logger
