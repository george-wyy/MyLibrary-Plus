from pathlib import Path
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import fitz
import httpx
import pytest
from sqlalchemy import inspect, text

from mylibrary.config import Settings
from mylibrary.schemas import AuthorData, PaperCandidate
from mylibrary.services.files import FileService, _StructuredFigureParser, _versioned_arxiv_id
from mylibrary.services.library import LibraryService
from mylibrary.services.citations import DAILY_REFRESH_SECONDS, DailyCitationUpdater


@pytest.mark.asyncio
async def test_add_candidate_and_deduplicate(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    candidate = PaperCandidate(
        title="Attention Is All You Need", source="test", year=2017,
        authors=[AuthorData(name="Ashish Vaswani")], arxiv_id="1706.03762",
        identifiers={"arxiv": "1706.03762"},
    )

    first = await service.add_candidate(candidate, download_pdf=False)
    original_added_at = service.get_paper(first.paper_id).created_at
    second = await service.add_candidate(candidate, download_pdf=False)

    assert first.created is True
    assert second.created is False
    assert len(service.list_papers()) == 1
    paper = service.get_paper(first.paper_id)
    assert paper is not None
    assert paper.created_at == original_added_at
    assert len(paper.add_events) == 2
    assert paper.latest_added_at == paper.add_events[-1].added_at
    assert paper.authors[0].author.name == "Ashish Vaswani"


@pytest.mark.asyncio
async def test_provider_identifier_deduplicates_a_revised_title(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    first = await service.add_candidate(PaperCandidate(
        title="Original title", source="openreview", identifiers={"openreview": "paper123"}
    ), download_pdf=False)
    second = await service.add_candidate(PaperCandidate(
        title="Revised title", source="openreview", identifiers={"openreview": "paper123"}
    ), download_pdf=False)

    assert second.paper_id == first.paper_id
    assert second.created is False
    assert len(service.list_papers()) == 1
    assert len(service.get_paper(first.paper_id).add_events) == 2


@pytest.mark.asyncio
async def test_existing_openreview_url_readds_without_network(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    first = await service.add_candidate(PaperCandidate(
        title="OpenReview paper", source="openreview", identifiers={"openreview": "paper123"}
    ), download_pdf=False)

    second = await service.add("https://openreview.net/forum?id=paper123")

    assert second.paper_id == first.paper_id
    assert second.created is False
    assert second.message == "Re-added OpenReview paper."
    assert len(service.get_paper(first.paper_id).add_events) == 2


@pytest.mark.asyncio
async def test_tags_are_case_insensitive_and_filterable(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    first = await service.add_candidate(PaperCandidate(title="First", source="test"), download_pdf=False)
    second = await service.add_candidate(PaperCandidate(title="Second", source="test"), download_pdf=False)

    truth = service.add_tag(first.paper_id, "Truth")
    same_truth = service.add_tag(second.paper_id, "truth")

    assert truth.id == same_truth.id
    assert [(tag.name, count) for tag, count in service.list_tags()] == [("Truth", 2)]
    assert {paper.title for paper in service.list_papers(tag_id=truth.id)} == {"First", "Second"}

    service.remove_tag(first.paper_id, truth.id)
    assert [paper.title for paper in service.list_papers(tag_id=truth.id)] == ["Second"]


@pytest.mark.asyncio
async def test_annotation_tags_are_normalized_deduplicated_and_reuse_existing_tags(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    result = await service.add_candidate(PaperCandidate(title="Tagged annotation", source="test"), download_pdf=False)
    existing = service.add_tag(result.paper_id, "Shared Topic")
    annotation = service.add_annotation(
        result.paper_id,
        1,
        "Selected passage",
        [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.04}],
    )

    tagged = service.set_annotation_tags(
        result.paper_id,
        annotation.id,
        ["  Shared   Topic  ", "shared topic", "Method"],
    )

    assert [tag.name for tag in tagged.tags] == ["Method", "Shared Topic"]
    assert tagged.tags[1].id == existing.id
    assert [(tag.name, count) for tag, count in service.list_tags()] == [("Shared Topic", 1)]


@pytest.mark.asyncio
async def test_annotation_tags_can_be_replaced_without_touching_unchanged_timestamp(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    result = await service.add_candidate(PaperCandidate(title="Retag annotation", source="test"), download_pdf=False)
    annotation = service.add_annotation(
        result.paper_id,
        1,
        "Selected passage",
        [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.04}],
    )
    first_update = datetime(2026, 8, 18, 10, 0)
    later_update = datetime(2026, 8, 18, 11, 0)

    with patch("mylibrary.services.library.utcnow", return_value=first_update):
        service.set_annotation_tags(result.paper_id, annotation.id, ["First", "Second"])
    before = service.list_annotations(result.paper_id)[0].updated_at
    with patch("mylibrary.services.library.utcnow", return_value=later_update):
        unchanged = service.set_annotation_tags(result.paper_id, annotation.id, [" second ", "FIRST"])

    assert unchanged.updated_at == before == first_update

    with patch("mylibrary.services.library.utcnow", return_value=later_update):
        replaced = service.set_annotation_tags(result.paper_id, annotation.id, ["Third"])

    assert [tag.name for tag in replaced.tags] == ["Third"]
    assert replaced.updated_at == later_update
    assert [tag.name for tag in service.list_annotation_tags()] == ["First", "Second", "Third"]


@pytest.mark.asyncio
async def test_annotation_tags_can_be_cleared_once_without_retouching_timestamp(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    result = await service.add_candidate(PaperCandidate(title="Clear annotation tags", source="test"), download_pdf=False)
    annotation = service.add_annotation(
        result.paper_id,
        1,
        "Selected passage",
        [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.04}],
    )
    first_clear = datetime(2026, 8, 18, 12, 0)
    redundant_clear = datetime(2026, 8, 18, 13, 0)
    service.set_annotation_tags(result.paper_id, annotation.id, ["Method"])

    with patch("mylibrary.services.library.utcnow", return_value=first_clear):
        cleared = service.set_annotation_tags(result.paper_id, annotation.id, [])
    with patch("mylibrary.services.library.utcnow", return_value=redundant_clear):
        still_clear = service.set_annotation_tags(result.paper_id, annotation.id, [])

    assert cleared.tags == []
    assert cleared.updated_at == first_clear
    assert still_clear.tags == []
    assert still_clear.updated_at == first_clear
    assert [tag.name for tag in service.list_annotation_tags()] == ["Method"]


@pytest.mark.asyncio
async def test_annotation_tag_update_rejects_an_annotation_owned_by_another_paper(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    owner = await service.add_candidate(PaperCandidate(title="Annotation owner", source="test"), download_pdf=False)
    other = await service.add_candidate(PaperCandidate(title="Different paper", source="test"), download_pdf=False)
    annotation = service.add_annotation(
        owner.paper_id,
        1,
        "Selected passage",
        [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.04}],
    )

    with pytest.raises(LookupError, match="Annotation not found"):
        service.set_annotation_tags(other.paper_id, annotation.id, ["Wrong owner"])

    assert service.list_annotations(owner.paper_id)[0].tags == []
    assert service.list_annotation_tags() == []


@pytest.mark.asyncio
async def test_deleting_annotation_cascades_its_tag_assignments(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    result = await service.add_candidate(PaperCandidate(title="Delete tagged annotation", source="test"), download_pdf=False)
    annotation = service.add_annotation(
        result.paper_id,
        1,
        "Selected passage",
        [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.04}],
    )
    service.set_annotation_tags(result.paper_id, annotation.id, ["Disposable assignment"])

    with service.engine.connect() as connection:
        before = connection.scalar(text(
            "SELECT COUNT(*) FROM annotation_tags WHERE annotation_id = :annotation_id"
        ), {"annotation_id": annotation.id})
    service.delete_annotation(result.paper_id, annotation.id)
    with service.engine.connect() as connection:
        after = connection.scalar(text(
            "SELECT COUNT(*) FROM annotation_tags WHERE annotation_id = :annotation_id"
        ), {"annotation_id": annotation.id})

    assert before == 1
    assert after == 0
    assert [tag.name for tag in service.list_annotation_tags()] == ["Disposable assignment"]


@pytest.mark.asyncio
async def test_annotation_tags_enforce_count_and_name_length_limits(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    result = await service.add_candidate(PaperCandidate(title="Limited tags", source="test"), download_pdf=False)
    annotation = service.add_annotation(
        result.paper_id,
        1,
        "Selected passage",
        [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.04}],
    )

    accepted = service.set_annotation_tags(
        result.paper_id,
        annotation.id,
        [f"tag-{index:02}" for index in range(20)],
    )
    assert len(accepted.tags) == 20

    with pytest.raises(ValueError, match="more than 20"):
        service.set_annotation_tags(result.paper_id, annotation.id, [f"tag-{index:02}" for index in range(21)])
    with pytest.raises(ValueError, match="exceed 100"):
        service.set_annotation_tags(result.paper_id, annotation.id, ["x" * 101])
    with pytest.raises(ValueError, match="cannot be empty"):
        service.set_annotation_tags(result.paper_id, annotation.id, ["   "])


@pytest.mark.asyncio
async def test_annotation_tag_vocabulary_is_sorted_and_annotation_queries_eager_load_tags(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    result = await service.add_candidate(PaperCandidate(title="Tag vocabulary", source="test"), download_pdf=False)
    service.add_tag(result.paper_id, "Zulu")
    pdf_annotation = service.add_annotation(
        result.paper_id,
        1,
        "PDF passage",
        [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.04}],
    )
    note_annotation = service.add_annotation(
        result.paper_id,
        0,
        "Note passage",
        [],
        target_type="note",
        anchor={"start": 0, "end": 12, "note_slug": "tagged-note"},
    )
    service.set_annotation_tags(result.paper_id, pdf_annotation.id, ["Middle"])
    service.set_annotation_tags(result.paper_id, note_annotation.id, ["Alpha"])

    assert [tag.name for tag in service.list_annotation_tags()] == ["Alpha", "Middle", "Zulu"]
    assert [[tag.name for tag in item.tags] for item in service.list_annotations(result.paper_id)] == [
        ["Middle"],
        ["Alpha"],
    ]
    assert [[tag.name for tag in item.tags] for item in service.list_all_annotations()] == [
        ["Middle"],
        ["Alpha"],
    ]
    assert [[tag.name for tag in item.tags] for item in service.list_note_annotations("tagged-note")] == [["Alpha"]]


@pytest.mark.asyncio
async def test_done_state_can_be_toggled(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    result = await service.add_candidate(PaperCandidate(title="Reading", source="test"), download_pdf=False)

    assert service.get_paper(result.paper_id).is_done is False
    service.set_done(result.paper_id, True)
    assert service.get_paper(result.paper_id).is_done is True
    assert service.get_paper(result.paper_id).marker == "check"
    service.set_done(result.paper_id, False)
    assert service.get_paper(result.paper_id).is_done is False
    assert service.get_paper(result.paper_id).marker is None


@pytest.mark.asyncio
async def test_existing_annotation_table_is_upgraded_without_losing_highlights(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)
    result = await service.add_candidate(PaperCandidate(title="Legacy Highlight", source="test"), download_pdf=False)

    with service.engine.begin() as connection:
        connection.execute(text("DROP TABLE annotation_replies"))
        connection.execute(text("DROP TABLE annotations"))
        connection.execute(text(
            "CREATE TABLE annotations ("
            "id VARCHAR(36) PRIMARY KEY, "
            "paper_id VARCHAR(36) NOT NULL REFERENCES papers(id) ON DELETE CASCADE, "
            "page_number INTEGER NOT NULL, selected_text TEXT NOT NULL, rects_json TEXT NOT NULL, "
            "color VARCHAR(20) NOT NULL, note TEXT, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)"
        ))
        connection.execute(text(
            "INSERT INTO annotations "
            "(id, paper_id, page_number, selected_text, rects_json, color, note, created_at, updated_at) "
            "VALUES ('legacy', :paper_id, 3, 'old quote', :rects, "
            "'yellow', 'old note', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ), {
            "paper_id": result.paper_id,
            "rects": '[{"x":0.1,"y":0.2,"width":0.3,"height":0.02}]',
        })

    upgraded = LibraryService(settings)
    columns = {column["name"] for column in inspect(upgraded.engine).get_columns("annotations")}
    annotation = upgraded.list_annotations(result.paper_id)[0]

    assert {"target_type", "anchor_json"} <= columns
    assert annotation.id == "legacy"
    assert annotation.target_type == "pdf"
    assert annotation.anchor_json == "{}"


@pytest.mark.asyncio
async def test_timeline_marker_can_be_changed(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    result = await service.add_candidate(PaperCandidate(title="Marked", source="test"), download_pdf=False)

    service.set_marker(result.paper_id, "star")
    paper = service.get_paper(result.paper_id)
    assert paper.marker == "star"
    assert paper.is_done is False

    service.set_marker(result.paper_id, "check")
    assert service.get_paper(result.paper_id).is_done is True


def test_daily_citation_refresh_schedule_survives_restarts(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    updater = DailyCitationUpdater(object(), settings)
    now = datetime(2026, 7, 20, 12, 0, tzinfo=timezone.utc)

    assert updater.seconds_until_due(now) == 10
    updater._save_attempt(now - timedelta(hours=23))
    assert updater.seconds_until_due(now) == 60 * 60
    updater._save_attempt(now - timedelta(days=2))
    assert updater.seconds_until_due(now) == 0
    assert DAILY_REFRESH_SECONDS == 24 * 60 * 60


@pytest.mark.asyncio
async def test_new_paper_citation_refresh_is_scoped_to_that_paper(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    first = await service.add_candidate(PaperCandidate(title="First Citation Paper", source="test"), download_pdf=False)
    second = await service.add_candidate(PaperCandidate(title="Second Citation Paper", source="test"), download_pdf=False)

    with patch("mylibrary.services.citations.CitationService.fetch", new_callable=AsyncMock, return_value=[]) as fetch:
        await service.update_citations([second.paper_id])

    checked = service.get_paper(second.paper_id)
    untouched = service.get_paper(first.paper_id)
    assert checked.citation_checked_at is not None
    assert untouched.citation_checked_at is None
    assert [paper.id for paper in fetch.await_args.args[0]] == [second.paper_id]


@pytest.mark.asyncio
async def test_notes_can_be_set_searched_and_cleared(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    result = await service.add_candidate(PaperCandidate(title="Notes Paper", source="test"), download_pdf=False)

    service.set_notes(result.paper_id, "A distinctive observation")
    assert service.get_paper(result.paper_id).notes == "A distinctive observation"
    assert [paper.id for paper in service.list_papers("distinctive")] == [result.paper_id]

    service.set_notes(result.paper_id, "  ")
    assert service.get_paper(result.paper_id).notes is None


@pytest.mark.asyncio
async def test_library_order_remains_based_on_added_time(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    first = await service.add_candidate(PaperCandidate(title="First", source="test"), download_pdf=False)
    await service.add_candidate(PaperCandidate(title="Second", source="test"), download_pdf=False)

    service.set_done(first.paper_id, True)

    assert service.list_papers()[0].title == "Second"

    await service.add_candidate(PaperCandidate(title="First", source="test"), download_pdf=False)

    assert service.list_papers()[0].title == "First"
    assert len(service.get_paper(first.paper_id).add_events) == 2


@pytest.mark.asyncio
async def test_pdf_download_is_validated_and_content_addressed(tmp_path: Path) -> None:
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "test paper")
    page.draw_rect(fitz.Rect(72, 120, 400, 300), color=(0, 0, 0), fill=(0.8, 0.9, 1.0))
    page.insert_text((72, 325), "Figure 1: A test diagram")
    pdf_bytes = document.tobytes()
    document.close()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "application/pdf"}, content=pdf_bytes)

    settings = Settings.create(tmp_path / "data")
    result = await FileService(settings, httpx.MockTransport(handler)).download_pdf(["https://example.test/paper.pdf"])

    assert result is not None
    assert settings.managed_path(result.relative_path).read_bytes() == pdf_bytes
    assert result.relative_path.startswith(f"files/{result.sha256[:2]}/")

    thumbnails = await FileService(settings, httpx.MockTransport(handler)).create_thumbnails(result.relative_path, result.sha256)
    assert set(thumbnails) == {"page-1", "figure-1"}
    for thumbnail_path in thumbnails.values():
        thumbnail = settings.managed_path(thumbnail_path)
        assert thumbnail.exists()
        assert thumbnail.read_bytes().startswith(b"\x89PNG")


def test_figure_crop_combines_separated_vector_stages(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = FileService(settings)
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.draw_rect(fitz.Rect(50, 100, 150, 180), color=(0, 0, 0))
    page.draw_rect(fitz.Rect(220, 102, 320, 178), color=(0, 0, 0))
    page.draw_rect(fitz.Rect(390, 115, 435, 165), color=(0, 0, 0))
    page.insert_text((35, 95), "Stage A", fontsize=10)
    page.insert_textbox(
        fitz.Rect(50, 210, 560, 250),
        "Figure 1: A three-stage vector diagram whose caption spans the full figure width for context.",
        fontsize=11,
    )

    figure = service._find_figure_one(document)
    document.close()

    assert figure is not None
    _page_number, crop = figure
    assert crop.x0 < 35
    assert crop.x1 > 435


def test_structured_html_parser_selects_semantic_figure_one() -> None:
    parser = _StructuredFigureParser()
    parser.feed("""
      <figure id="S2.F2"><img src="assets/two.png"><figcaption>Figure 2: Later</figcaption></figure>
      <figure id="S1.F1"><img src="assets/left.png"><img src="/right.png"><figcaption>Figure 1: Method</figcaption></figure>
    """)

    assert parser.figure_urls(1, "https://example.test/html/1234") == [
        "https://example.test/html/assets/left.png",
        "https://example.test/right.png",
    ]


def test_structured_html_uses_official_base_and_pdf_version() -> None:
    parser = _StructuredFigureParser()
    parser.feed('<base href="/html/2601.21900v2/"><figure id="S2.F2"><img src="x3.png"></figure>')

    assert parser.figure_urls(2, "https://arxiv.org/html/2601.21900v2") == [
        "https://arxiv.org/html/2601.21900v2/x3.png"
    ]
    assert _versioned_arxiv_id("2601.21900", "https://arxiv.org/pdf/2601.21900v2") == "2601.21900v2"


def test_structured_figure_panels_are_composed(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = FileService(settings)
    panels = []
    for color in ((1, 0, 0), (0, 0, 1)):
        document = fitz.open()
        page = document.new_page(width=100, height=80)
        page.draw_rect(page.rect, color=color, fill=color)
        panels.append(page.get_pixmap(alpha=False).tobytes("png"))
        document.close()

    destination = settings.thumbnails_dir / "composed.png"
    service._render_structured_figure(panels, destination, width=640, force=True)

    composed = fitz.Pixmap(destination)
    assert composed.width > composed.height * 2
    assert composed.width == 202
    assert composed.height == 80


@pytest.mark.asyncio
async def test_timeline_thumbnail_source_can_be_changed(tmp_path: Path) -> None:
    service = LibraryService(Settings.create(tmp_path / "data"))
    result = await service.add_candidate(PaperCandidate(title="Thumbnail Choice", source="test"), download_pdf=False)

    assert service.get_paper(result.paper_id).thumbnail_source == "figure-1"
    service.set_thumbnail_source(result.paper_id, "figure-3")
    assert service.get_paper(result.paper_id).thumbnail_source == "figure-3"
    with pytest.raises(ValueError):
        service.set_thumbnail_source(result.paper_id, "figure-4")


@pytest.mark.asyncio
async def test_non_pdf_download_is_rejected(tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=b"<html>not a pdf</html>"))
    result = await FileService(Settings.create(tmp_path / "data"), transport).download_pdf(["https://example.test/not-pdf"])
    assert result is None
