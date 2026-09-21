import re
from datetime import datetime, timezone
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from mylibrary.config import Settings
from mylibrary.models import StoredFile
from mylibrary.schemas import AuthorData, PaperCandidate
from mylibrary.services.library import LibraryService
from mylibrary.web.app import LOCAL_TIMEZONE, _local_time, _tag_style, _timeline_day, create_app


def test_empty_library_page_and_api(tmp_path: Path) -> None:
    with TestClient(create_app(Settings.create(tmp_path / "data"))) as client:
        page = client.get("/")
        api = client.get("/api/papers")

    assert page.status_code == 200
    assert "Recent activity" not in page.text
    assert 'class="search-form"' in page.text
    assert "Enter a paper title" not in page.text
    with TestClient(create_app(Settings.create(tmp_path / "other-data"))) as client:
        add_page = client.get("/add")
    assert "Enter a paper title" in add_page.text
    assert api.json() == []


def test_favicon_is_available(tmp_path: Path) -> None:
    with TestClient(create_app(Settings.create(tmp_path / "data"))) as client:
        page = client.get("/")
        icon = client.get("/favicon.ico")

    assert '<link rel="icon" href="/favicon.ico"' in page.text
    assert icon.status_code == 200
    assert icon.headers["content-type"] == "image/x-icon"
    assert icon.content.startswith(b"\x00\x00\x01\x00")


def test_added_timestamp_is_visible_in_detail_and_api(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="A Test Paper", source="test"), download_pdf=False))

    with TestClient(create_app(settings)) as client:
        detail = client.get(f"/paper/{result.paper_id}")
        record = client.get("/api/papers").json()[0]

    assert detail.status_code == 200
    assert "Added" in detail.text
    assert "Venue" not in detail.text
    assert record["added_at"]
    assert record["first_added_at"]
    assert len(record["add_history"]) == 1
    assert record["updated_at"]
    assert record["figure_thumbnail_url"] is None
    assert record["page_thumbnail_url"] is None


def test_timeline_omits_venue_but_detail_retains_it(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Venue Test", source="test", venue="Example Conference"), download_pdf=False))

    with TestClient(create_app(settings)) as client:
        timeline = client.get("/")
        detail = client.get(f"/paper/{result.paper_id}")

    assert "Example Conference" not in timeline.text
    assert "Example Conference" in detail.text


def test_detail_omits_abstract_in_favor_of_visual_preview(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Visual Paper", source="test", abstract="Hidden abstract text"), download_pdf=False))

    with TestClient(create_app(settings)) as client:
        detail = client.get(f"/paper/{result.paper_id}")

    assert "Hidden abstract text" not in detail.text
    assert "Abstract" not in detail.text


def test_notes_can_be_edited_in_gui_and_are_in_api(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Annotated", source="test"), download_pdf=False))

    with TestClient(create_app(settings)) as client:
        response = client.post(f"/paper/{result.paper_id}/notes", data={"notes": "Useful result"})
        detail = client.get(f"/paper/{result.paper_id}")
        timeline = client.get("/")
        record = client.get("/api/papers").json()[0]

    assert response.status_code == 200
    assert "Useful result" in detail.text
    assert 'class="card-note"' in timeline.text
    assert "Useful result" in timeline.text
    assert f'/paper/{result.paper_id}#notes' in timeline.text
    assert record["notes"] == "Useful result"


def test_timeline_thumbnail_preference_is_in_api(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Thumbnail Preference", source="test"), download_pdf=False))

    with TestClient(create_app(settings)) as client:
        response = client.post(
            f"/paper/{result.paper_id}/thumbnail-source",
            data={"source": "figure-2"},
            headers={"X-Requested-With": "MyLibrary"},
        )
        record = client.get("/api/papers").json()[0]

    assert response.status_code == 200
    assert response.json() == {"id": result.paper_id, "thumbnail_source": "figure-2"}
    assert record["thumbnail_source"] == "figure-2"


def test_highlights_persist_and_can_be_edited_and_deleted(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Annotated PDF", source="test"), download_pdf=False))
    payload = {
        "page_number": 2,
        "selected_text": "A durable selected passage",
        "rects": [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.02}],
        "color": "yellow",
    }

    with TestClient(create_app(settings)) as client:
        created = client.post(f"/api/papers/{result.paper_id}/annotations", json=payload)
        annotation_id = created.json()["id"]
        saved = LibraryService(settings).list_annotations(result.paper_id)
        edited = client.patch(
            f"/api/papers/{result.paper_id}/annotations/{annotation_id}",
            json={"note": "Important evidence"},
        )
        deleted = client.delete(f"/api/papers/{result.paper_id}/annotations/{annotation_id}")

    assert created.status_code == 201
    assert saved[0].selected_text == "A durable selected passage"
    assert json.loads(saved[0].rects_json)[0]["x"] == 0.1
    assert edited.json()["note"] == "Important evidence"
    assert deleted.status_code == 204
    assert LibraryService(settings).list_annotations(result.paper_id) == []


def test_annotation_api_exposes_tags_and_preserves_omitted_patch_fields(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Tagged Annotation", source="test"), download_pdf=False))
    payload = {
        "page_number": 2,
        "selected_text": "A tagged passage",
        "rects": [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.02}],
        "note": "Keep this note",
        "tags": ["  Method  ", "method", "Question"],
    }

    with TestClient(create_app(settings)) as client:
        created = client.post(f"/api/papers/{result.paper_id}/annotations", json=payload)
        annotation_id = created.json()["id"]
        tags_only = client.patch(
            f"/api/papers/{result.paper_id}/annotations/{annotation_id}",
            json={"tags": ["Evidence"]},
        )
        note_only = client.patch(
            f"/api/papers/{result.paper_id}/annotations/{annotation_id}",
            json={"note": "Updated note"},
        )
        cleared = client.patch(
            f"/api/papers/{result.paper_id}/annotations/{annotation_id}",
            json={"tags": []},
        )

    assert created.status_code == 201
    assert created.json()["tags"] == ["Method", "Question"]
    assert created.json()["created_at"]
    assert created.json()["updated_at"]
    assert tags_only.status_code == 200
    assert tags_only.json()["note"] == "Keep this note"
    assert tags_only.json()["tags"] == ["Evidence"]
    assert note_only.status_code == 200
    assert note_only.json()["note"] == "Updated note"
    assert note_only.json()["tags"] == ["Evidence"]
    assert cleared.status_code == 200
    assert cleared.json()["note"] == "Updated note"
    assert cleared.json()["tags"] == []


def test_annotation_tags_propagate_to_list_context_and_concept_payloads(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Annotation Payloads", source="test"), download_pdf=False))

    with TestClient(create_app(settings)) as client:
        created = client.post(
            f"/api/papers/{result.paper_id}/annotations",
            json={
                "target_type": "note",
                "selected_text": "shared concept",
                "anchor": {"start": 0, "end": 14, "note_slug": "shared-concept"},
                "tags": ["Concept"],
            },
        )
        paper_annotations = client.get(f"/api/papers/{result.paper_id}/annotations")
        all_annotations = client.get("/api/annotations")
        context = client.get(f"/api/papers/{result.paper_id}/annotations/context")
        concept_annotations = client.get("/api/notes/shared-concept/annotations")
        reply = client.post(
            f"/api/papers/{result.paper_id}/annotations/{created.json()['id']}/replies",
            json={"content": "A UTC-timestamped reply"},
        )
        reloaded_after_reply = client.get(f"/api/papers/{result.paper_id}/annotations")

    assert created.status_code == 201
    annotation_payloads = (
        created.json(),
        paper_annotations.json()[0],
        all_annotations.json()[0],
        context.json()["annotations"][0],
        concept_annotations.json()[0],
    )
    for annotation in annotation_payloads:
        assert annotation["tags"] == ["Concept"]
    for field in ("created_at", "updated_at"):
        instants = [datetime.fromisoformat(annotation[field]) for annotation in annotation_payloads]
        assert all(instant.utcoffset() is not None for instant in instants)
        assert len({instant.astimezone(timezone.utc) for instant in instants}) == 1

    assert reply.status_code == 201
    reply_instants = [
        datetime.fromisoformat(reply.json()["created_at"]),
        datetime.fromisoformat(reloaded_after_reply.json()[0]["replies"][0]["created_at"]),
    ]
    assert all(instant.utcoffset() is not None for instant in reply_instants)
    assert len({instant.astimezone(timezone.utc) for instant in reply_instants}) == 1


def test_annotation_api_rejects_malformed_and_oversized_tag_payloads(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Tag Validation", source="test"), download_pdf=False))
    base_payload = {
        "page_number": 1,
        "selected_text": "quote",
        "rects": [{"x": .1, "y": .2, "width": .2, "height": .03}],
    }

    with TestClient(create_app(settings)) as client:
        malformed_responses = [
            client.post(
                f"/api/papers/{result.paper_id}/annotations",
                json={**base_payload, "tags": malformed_tags},
            )
            for malformed_tags in ("Method", ["Method", 3], [""], ["x" * 101], [f"tag-{index}" for index in range(21)])
        ]
        created = client.post(f"/api/papers/{result.paper_id}/annotations", json=base_payload)
        patch_malformed = client.patch(
            f"/api/papers/{result.paper_id}/annotations/{created.json()['id']}",
            json={"tags": {"name": "Method"}},
        )

    assert all(response.status_code == 400 for response in malformed_responses)
    assert patch_malformed.status_code == 400


def test_wrong_paper_tag_patch_does_not_create_orphan_tag(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    first = asyncio.run(service.add_candidate(PaperCandidate(title="Tag Owner", source="test"), download_pdf=False))
    second = asyncio.run(service.add_candidate(PaperCandidate(title="Wrong Tag Owner", source="test"), download_pdf=False))

    with TestClient(create_app(settings)) as client:
        created = client.post(
            f"/api/papers/{first.paper_id}/annotations",
            json={
                "page_number": 1,
                "selected_text": "quote",
                "rects": [{"x": .1, "y": .2, "width": .2, "height": .03}],
            },
        )
        wrong_paper = client.patch(
            f"/api/papers/{second.paper_id}/annotations/{created.json()['id']}",
            json={"tags": ["Must Not Exist"]},
        )

    assert wrong_paper.status_code == 404
    assert "must not exist" not in {tag.normalized_name for tag in service.list_annotation_tags()}


def test_lecture_annotations_have_threads_and_ai_context(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Lecture Notes", source="test"), download_pdf=False))
    payload = {
        "target_type": "lecture",
        "page_number": 0,
        "selected_text": "结构化表示",
        "rects": [],
        "note": "这里和几何约束有什么关系？",
        "anchor": {
            "exact": "结构化表示",
            "prefix": "模型学习",
            "suffix": "并用于下游任务",
            "start": 12,
            "end": 18,
        },
    }

    with TestClient(create_app(settings)) as client:
        created = client.post(f"/api/papers/{result.paper_id}/annotations", json=payload)
        annotation_id = created.json()["id"]
        user_reply = client.post(
            f"/api/papers/{result.paper_id}/annotations/{annotation_id}/replies",
            json={"content": "先对照方法图。"},
        )
        ai_reply = client.post(
            f"/api/papers/{result.paper_id}/annotations/{annotation_id}/replies",
            json={"content": "它把视线几何编码进特征空间。", "role": "assistant"},
        )
        listed = client.get(f"/api/papers/{result.paper_id}/annotations")
        context = client.get(f"/api/papers/{result.paper_id}/annotations/context")

    assert created.status_code == 201
    assert created.json()["target_type"] == "lecture"
    assert created.json()["anchor"]["start"] == 12
    assert created.json()["rects"] == []
    assert user_reply.status_code == 201
    assert ai_reply.status_code == 201
    assert [reply["role"] for reply in listed.json()[0]["replies"]] == ["user", "assistant"]
    assert context.json()["paper"]["title"] == "Lecture Notes"
    assert context.json()["annotations"][0]["note"] == "这里和几何约束有什么关系？"
    assert "role=assistant" in context.json()["instructions"]


def test_all_annotations_include_paper_titles_and_current_list_stays_scoped(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    first = asyncio.run(service.add_candidate(PaperCandidate(title="First Annotated Paper", source="test"), download_pdf=False))
    second = asyncio.run(service.add_candidate(PaperCandidate(title="Second Annotated Paper", source="test"), download_pdf=False))
    rects = [{"x": .1, "y": .2, "width": .2, "height": .03}]

    with TestClient(create_app(settings)) as client:
        client.post(
            f"/api/papers/{first.paper_id}/annotations",
            json={"page_number": 1, "selected_text": "first quote", "rects": rects, "note": "first note"},
        )
        client.post(
            f"/api/papers/{second.paper_id}/annotations",
            json={"page_number": 2, "selected_text": "second quote", "rects": rects, "note": "second note"},
        )
        current = client.get(f"/api/papers/{first.paper_id}/annotations")
        all_annotations = client.get("/api/annotations")

    assert [item["selected_text"] for item in current.json()] == ["first quote"]
    assert {
        (item["paper_title"], item["selected_text"])
        for item in all_annotations.json()
    } == {
        ("First Annotated Paper", "first quote"),
        ("Second Annotated Paper", "second quote"),
    }


def test_annotation_validation_and_paper_ownership(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    first = asyncio.run(service.add_candidate(PaperCandidate(title="First Annotation Paper", source="test"), download_pdf=False))
    second = asyncio.run(service.add_candidate(PaperCandidate(title="Second Annotation Paper", source="test"), download_pdf=False))

    with TestClient(create_app(settings)) as client:
        invalid_anchor = client.post(
            f"/api/papers/{first.paper_id}/annotations",
            json={"target_type": "lecture", "selected_text": "quote", "note": "note", "anchor": {}},
        )
        created = client.post(
            f"/api/papers/{first.paper_id}/annotations",
            json={
                "page_number": 1,
                "selected_text": "quote",
                "rects": [{"x": .1, "y": .2, "width": .2, "height": .03}],
                "note": "note",
            },
        )
        annotation_id = created.json()["id"]
        wrong_paper_edit = client.patch(
            f"/api/papers/{second.paper_id}/annotations/{annotation_id}",
            json={"note": "not allowed"},
        )
        invalid_role = client.post(
            f"/api/papers/{first.paper_id}/annotations/{annotation_id}/replies",
            json={"content": "answer", "role": "system"},
        )
        empty_reply = client.post(
            f"/api/papers/{first.paper_id}/annotations/{annotation_id}/replies",
            json={"content": "  "},
        )

    assert invalid_anchor.status_code == 400
    assert wrong_paper_edit.status_code == 404
    assert invalid_role.status_code == 400
    assert empty_reply.status_code == 400


def test_reader_and_study_pages_load_shared_annotation_ui(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Annotation UI", source="test"), download_pdf=False))
    with service.sessions.begin() as session:
        session.add(StoredFile(
            paper_id=result.paper_id,
            relative_path="files/aa/annotation-ui.pdf",
            sha256="b" * 64,
            size_bytes=10,
            source_url=None,
        ))
    lectures = settings.data_dir / "lectures"
    lectures.mkdir(parents=True)
    (lectures / f"{result.paper_id}.md").write_text("# 讲义\n\n可批注的正文。", encoding="utf-8")

    with TestClient(create_app(settings)) as client:
        reader = client.get(f"/paper/{result.paper_id}/read")
        study = client.get(f"/paper/{result.paper_id}/study")

    assert reader.status_code == 200
    assert re.search(r"/static/annotations\.css\?v=\d+", reader.text)
    assert re.search(r"/static/vendor/katex/katex\.min\.css\?v=\d+", reader.text)
    assert re.search(r"/static/vendor/katex/katex\.min\.js\?v=\d+", reader.text)
    assert 'id="initial-annotations"' in reader.text
    assert re.search(r"/static/reader\.js\?v=\d+", reader.text)
    assert study.status_code == 200
    assert 'id="study-pdf"' in study.text
    assert re.search(r"/static/study\.js\?v=\d+", study.text)
    assert re.search(r"/static/annotations\.css\?v=\d+", study.text)
    assert re.search(r"/static/vendor/katex/katex\.min\.css\?v=\d+", study.text)
    assert re.search(r"/static/vendor/katex/katex\.min\.js\?v=\d+", study.text)


def test_lecture_asset_route_serves_whitelisted_files_inside_paper_dir(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Widget Assets", source="test"), download_pdf=False))
    assets_root = settings.data_dir / "lectures" / "assets"
    assets = assets_root / result.paper_id
    (assets / "demo").mkdir(parents=True)
    (assets / "demo" / "widget.html").write_text("<p>widget</p>", encoding="utf-8")
    (assets / "demo" / "data.json").write_text('{"ok": true}', encoding="utf-8")
    (assets / "run.py").write_text("print('no')", encoding="utf-8")
    # Whitelisted extension, one level above this paper's asset dir: only
    # reachable by escaping it, so a 200 here would mean traversal worked.
    (assets_root / "secret.txt").write_text("secret", encoding="utf-8")
    (assets / "link.txt").symlink_to(assets_root / "secret.txt")

    base = f"/paper/{result.paper_id}/lecture-asset"
    with TestClient(create_app(settings)) as client:
        page = client.get(f"{base}/demo/widget.html")
        data = client.get(f"{base}/demo/data.json")
        escapes = [
            client.get(f"{base}/{probe}")
            for probe in ("..%2Fsecret.txt", "%2e%2e/secret.txt", "demo/..%2F..%2Fsecret.txt", "%2Fetc%2Fhosts", "link.txt")
        ]
        blocked_type = client.get(f"{base}/run.py")
        missing = client.get(f"{base}/demo/nope.html")
        unknown_paper = client.get("/paper/00000000-0000-0000-0000-000000000000/lecture-asset/demo/widget.html")

    assert page.status_code == 200
    assert page.text == "<p>widget</p>"
    assert page.headers["content-type"].startswith("text/html")
    assert page.headers["cache-control"] == "no-cache"
    assert "etag" in page.headers and "last-modified" in page.headers
    assert data.status_code == 200
    assert data.headers["content-type"].startswith("application/json")
    assert [response.status_code for response in escapes] == [404] * len(escapes)
    assert all("secret" not in response.text for response in escapes)
    assert blocked_type.status_code == 415
    assert missing.status_code == 404
    assert unknown_paper.status_code == 404


def test_annotation_sidebar_metadata_ui_contracts() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "mylibrary" / "web" / "static"
    annotations_js = (static_dir / "annotations.js").read_text(encoding="utf-8")
    annotations_css = (static_dir / "annotations.css").read_text(encoding="utf-8")
    reader_js = (static_dir / "reader.js").read_text(encoding="utf-8")
    study_js = (static_dir / "study.js").read_text(encoding="utf-8")

    assert re.search(r'from "/static/annotation-metadata\.mjs\?v=\d+"', annotations_js)
    assert 'from "/static/annotation-form-state.mjs?v=1"' in annotations_js
    assert "data-annotation-query" in annotations_js
    assert "data-annotation-tag-filter" in annotations_js
    assert 'form.dataset.form = "tags"' in annotations_js
    assert "annotation-timestamp" in annotations_js
    assert "annotation-timestamp" in annotations_css
    assert "renderTimestamp(annotation.updated_at" in annotations_js
    assert "renderExactTimestamp(annotation.created_at" in annotations_js
    assert "renderExactTimestamp(annotation.updated_at" in annotations_js
    assert "reconcileAnnotationPanelSelection" in annotations_js
    assert "isActiveAnnotationTagEdit" in annotations_js
    assert "parseAnnotationTags" in annotations_js
    assert "resolveAnnotationMutationUi" in annotations_js
    assert "grid-template-rows: auto auto auto minmax(0, min(36vh, 300px)) minmax(0, 1fr)" in annotations_css
    assert "height: calc(100vh" not in annotations_css
    assert "lockAnnotationForm" in annotations_js
    assert re.search(r'from "/static/annotations\.js\?v=\d+"', reader_js)
    assert re.search(r'from "/static/annotations\.js\?v=\d+"', study_js)
    assert re.search(r'from "/static/floating-window\.mjs\?v=\d+"', study_js)
    assert re.search(r'from "/static/math-markdown\.mjs\?v=\d+"', annotations_js)
    assert re.search(r'from "/static/math-markdown\.mjs\?v=\d+"', study_js)


def test_existing_thumbnail_is_served_without_pdf_processing(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Cached Thumbnail", source="test"), download_pdf=False))
    sha256 = "a" * 64
    with service.sessions.begin() as session:
        session.add(StoredFile(
            paper_id=result.paper_id,
            relative_path="files/aa/paper.pdf",
            sha256=sha256,
            size_bytes=10,
            source_url=None,
        ))
    thumbnail = settings.managed_path(service.files.thumbnail_relative_path(sha256, "figure-1"))
    thumbnail.parent.mkdir(parents=True, exist_ok=True)
    thumbnail.write_bytes(b"cached thumbnail")
    pdf = settings.managed_path("files/aa/paper.pdf")
    pdf.parent.mkdir(parents=True, exist_ok=True)
    pdf.write_bytes(b"%PDF test download")

    with patch("mylibrary.services.files.FileService.create_thumbnails", new_callable=AsyncMock) as create:
        with TestClient(create_app(settings)) as client:
            response = client.get(f"/paper/{result.paper_id}/thumbnail?source=figure-1&v=3")
            download = client.get(f"/paper/{result.paper_id}/download")
            detail = client.get(f"/paper/{result.paper_id}")

    assert response.status_code == 200
    assert response.content == b"cached thumbnail"
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    create.assert_not_awaited()
    assert download.content == b"%PDF test download"
    assert download.headers["content-disposition"].startswith("attachment;")
    assert f'href="/paper/{result.paper_id}/read"' in detail.text
    assert 'data-preview-name="figure-1"' in detail.text
    assert 'data-figure-lightbox' in detail.text


def test_detail_shows_all_authors_while_timeline_stays_short(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)
    candidate = PaperCandidate(
        title="Many Authors",
        source="test",
        authors=[AuthorData(name="First Author"), AuthorData(name="Middle Author"), AuthorData(name="Last Author")],
    )

    import asyncio
    result = asyncio.run(service.add_candidate(candidate, download_pdf=False))

    with TestClient(create_app(settings)) as client:
        detail = client.get(f"/paper/{result.paper_id}")
        timeline = client.get("/")
        api = client.get("/api/papers").json()[0]

    assert "First Author, Middle Author, Last Author" in detail.text
    assert "First Author, …, Last Author" in timeline.text
    assert api["authors"] == ["First Author", "Middle Author", "Last Author"]


def test_timeline_and_tag_view(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Tagged Paper", source="test"), download_pdf=False))
    tag = service.add_tag(result.paper_id, "Truth")

    with TestClient(create_app(settings)) as client:
        timeline = client.get("/")
        tags = client.get("/tags")
        tagged = client.get(f"/tags/{tag.id}")
        detail = client.get(f"/paper/{result.paper_id}")

    assert "Recent activity" not in timeline.text
    assert 'class="search-form"' in timeline.text
    assert "Added" in timeline.text
    assert "#Truth" in timeline.text
    assert 'class="paper-title"' in timeline.text
    assert 'class="thumbnail-link"' in timeline.text
    assert "Set paper marker" in timeline.text
    assert 'class="metadata-link"' in timeline.text
    assert "1 paper" in tags.text
    assert "Tagged Paper" in tagged.text
    assert "Add tag" in detail.text


def test_tag_colors_are_stable_by_text() -> None:
    assert _tag_style("Truth") == _tag_style("truth")
    assert _tag_style("Truth") != _tag_style("Classic")
    assert "--tag-bg:hsl(" in _tag_style("Truth")


def test_gui_converts_utc_to_singapore_time() -> None:
    value = datetime(2026, 7, 19, 3, 30, tzinfo=timezone.utc)
    assert _local_time(value).strftime("%Y-%m-%d %H:%M") == "2026-07-19 11:30"


def test_timeline_day_labels_today_and_yesterday() -> None:
    today = datetime(2026, 7, 20, 12, 0, tzinfo=LOCAL_TIMEZONE).date()
    assert _timeline_day(datetime(2026, 7, 20, 3, 0, tzinfo=timezone.utc), today).startswith("Today · Monday, July 20, 2026")
    assert _timeline_day(datetime(2026, 7, 19, 3, 0, tzinfo=timezone.utc), today).startswith("Yesterday · Sunday, July 19, 2026")


def test_done_marker_and_api_field(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Read Me", source="test"), download_pdf=False))

    with TestClient(create_app(settings)) as client:
        response = client.post(f"/paper/{result.paper_id}/done", data={"done": "true"})
        timeline = client.get("/")
        detail = client.get(f"/paper/{result.paper_id}")
        record = client.get("/api/papers").json()[0]

    assert response.status_code == 200
    assert "marker-check" in timeline.text
    assert "✓ Read" in detail.text
    assert record["done"] is True


def test_done_ajax_returns_state_without_redirect(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Stay Put", source="test"), download_pdf=False))

    with TestClient(create_app(settings)) as client:
        response = client.post(
            f"/paper/{result.paper_id}/done",
            data={"done": "true"},
            headers={"X-Requested-With": "MyLibrary"},
            follow_redirects=False,
        )

    assert response.status_code == 200
    assert response.json() == {"id": result.paper_id, "done": True}
    assert "location" not in response.headers


def test_marker_ajax_updates_marker_and_read_state(tmp_path: Path) -> None:
    settings = Settings.create(tmp_path / "data")
    service = LibraryService(settings)

    import asyncio
    result = asyncio.run(service.add_candidate(PaperCandidate(title="Choose Marker", source="test"), download_pdf=False))

    with TestClient(create_app(settings)) as client:
        response = client.post(f"/paper/{result.paper_id}/marker", data={"marker": "question"})
        record = client.get("/api/papers").json()[0]

    assert response.json() == {"id": result.paper_id, "marker": "question", "done": False}
    assert record["marker"] == "question"
