from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

from ..schemas import PaperCandidate


def normalize_title(title: str) -> str:
    value = unicodedata.normalize("NFKC", title).casefold()
    value = re.sub(r"[^\w\s]", " ", value)
    return " ".join(value.split())


def score_candidate(query: str, candidate: PaperCandidate, author: str | None = None, year: int | None = None) -> float:
    query_title = normalize_title(query)
    candidate_title = normalize_title(candidate.title)
    title_score = SequenceMatcher(None, query_title, candidate_title).ratio()
    if query_title == candidate_title:
        title_score = 1.0
    score = title_score * 0.75
    if len(candidate.sources) > 1:
        score += min(0.15, 0.05 * (len(candidate.sources) - 1))
    if candidate.doi or candidate.arxiv_id or candidate.pmid:
        score += 0.05
    # arXiv title search is phrase-based and its record is authoritative for an
    # arXiv work. This small preference prevents later chapters that reuse an
    # exact paper title from outranking the original preprint.
    if "arxiv" in candidate.sources and query_title == candidate_title:
        score += 0.08
    if "openreview" in candidate.sources and query_title == candidate_title:
        score += 0.15
    if author:
        wanted = normalize_title(author)
        if any(wanted in normalize_title(item.name) for item in candidate.authors):
            score += 0.10
    if year is not None and candidate.year == year:
        score += 0.05
    return min(score, 1.0)


def merge_candidates(candidates: list[PaperCandidate]) -> list[PaperCandidate]:
    merged: list[PaperCandidate] = []
    for candidate in candidates:
        existing = next((item for item in merged if _same_work(item, candidate)), None)
        if existing is None:
            merged.append(candidate)
        else:
            _supplement(existing, candidate)
    return merged


def _same_work(left: PaperCandidate, right: PaperCandidate) -> bool:
    if left.doi and right.doi and left.doi == right.doi:
        return True
    if left.arxiv_id and right.arxiv_id and left.arxiv_id == right.arxiv_id:
        return True
    titles_match = normalize_title(left.title) == normalize_title(right.title)
    return titles_match and (not left.year or not right.year or left.year == right.year)


def _supplement(base: PaperCandidate, extra: PaperCandidate) -> None:
    base.sources.extend(source for source in extra.sources if source not in base.sources)
    for field in ("abstract", "publication_date", "year", "venue", "volume", "issue", "pages", "paper_type", "doi", "arxiv_id", "pmid", "canonical_url"):
        if not getattr(base, field) and getattr(extra, field):
            setattr(base, field, getattr(extra, field))
    if not base.authors and extra.authors:
        base.authors = extra.authors
    base.pdf_urls.extend(url for url in extra.pdf_urls if url not in base.pdf_urls)
    base.identifiers.update({key: value for key, value in extra.identifiers.items() if key not in base.identifiers})
    base.raw[extra.source] = extra.raw
