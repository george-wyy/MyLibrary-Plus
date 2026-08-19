from pathlib import Path

import httpx

from mylibrary.config import Settings
from mylibrary.providers.arxiv import extract_arxiv_id
from mylibrary.providers.openreview import extract_openreview_id
from mylibrary.services.discovery import DiscoveryService, classify_input


def test_versioned_arxiv_url_is_classified_as_arxiv() -> None:
    query = "https://arxiv.org/abs/2605.27081v1"

    assert extract_arxiv_id(query) == "2605.27081"
    assert classify_input(query) == "arxiv"


async def test_failed_arxiv_lookup_does_not_fall_back_to_title_search(tmp_path: Path) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(503, text="temporarily unavailable")

    discovery = DiscoveryService(Settings.create(tmp_path / "data"), httpx.MockTransport(handler))
    candidates = await discovery.discover("https://arxiv.org/abs/2605.27081v1")

    assert candidates == []
    assert len(requests) == 1
    assert requests[0].url.host == "export.arxiv.org"
    assert requests[0].url.params["id_list"] == "2605.27081"


async def test_openreview_url_uses_json_api(tmp_path: Path) -> None:
    query = "https://openreview.net/forum?id=wn6WHREK9k"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "api2.openreview.net"
        assert request.url.params["id"] == "wn6WHREK9k"
        return httpx.Response(200, json={"notes": [{
            "id": "wn6WHREK9k",
            "cdate": 1_719_792_000_000,
            "content": {
                "title": {"value": "Oracle-MoE"},
                "authors": {"value": ["Jixian Zhou", "Fang Dong"]},
                "abstract": {"value": "A routing paper."},
                "venue": {"value": "ICML 2025"},
            },
        }]})

    assert extract_openreview_id(query) == "wn6WHREK9k"
    assert classify_input(query) == "openreview"
    discovery = DiscoveryService(Settings.create(tmp_path / "data"), httpx.MockTransport(handler))
    candidates = await discovery.discover(query)

    assert len(candidates) == 1
    assert candidates[0].title == "Oracle-MoE"
    assert [author.name for author in candidates[0].authors] == ["Jixian Zhou", "Fang Dong"]
    assert candidates[0].identifiers == {"openreview": "wn6WHREK9k"}
    assert candidates[0].pdf_urls == ["https://openreview.net/pdf?id=wn6WHREK9k"]
    assert candidates[0].score >= 0.86
