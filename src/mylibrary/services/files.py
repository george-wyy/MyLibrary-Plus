from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

import fitz
import httpx

from ..config import Settings


@dataclass
class DownloadedFile:
    relative_path: str
    sha256: str
    size_bytes: int
    source_url: str


class _StructuredFigureParser(HTMLParser):
    """Collect image URLs from the semantically identified Figure 1 element."""

    def __init__(self) -> None:
        super().__init__()
        self.depth = 0
        self.current_id = ""
        self.current_images: list[str] = []
        self.current_text: list[str] = []
        self.figures: list[tuple[str, list[str], str]] = []
        self.base_href: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "base" and values.get("href"):
            self.base_href = values["href"]
        elif tag == "figure":
            if self.depth == 0:
                self.current_id = values.get("id") or ""
                self.current_images = []
                self.current_text = []
            self.depth += 1
        elif self.depth and tag == "img" and values.get("src"):
            self.current_images.append(values["src"] or "")

    def handle_endtag(self, tag: str) -> None:
        if tag != "figure" or not self.depth:
            return
        self.depth -= 1
        if self.depth == 0:
            self.figures.append((self.current_id, self.current_images, " ".join(self.current_text)))

    def handle_data(self, data: str) -> None:
        if self.depth:
            self.current_text.append(data)

    def figure_urls(self, figure_number: int, base_url: str) -> list[str]:
        asset_base = urljoin(base_url, self.base_href) if self.base_href else base_url
        for figure_id, images, text in self.figures:
            id_matches = re.search(rf"(?:^|\.)F{figure_number}(?:$|\.)", figure_id, re.I) is not None
            caption_matches = re.search(rf"\bFigure\s*{figure_number}\s*[:.]", " ".join(text.split()), re.I) is not None
            if (id_matches or caption_matches) and images:
                return [urljoin(asset_base, source) for source in images]
        return []


class FileService:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.settings = settings
        self.transport = transport

    async def download_pdf(self, urls: list[str]) -> DownloadedFile | None:
        self.settings.initialize()
        for url in urls:
            try:
                downloaded = await self._download_one(url)
                if downloaded:
                    return downloaded
            except (httpx.HTTPError, ValueError, fitz.FileDataError):
                continue
        return None

    async def create_thumbnails(self, relative_pdf_path: str, sha256: str, *, width: int = 1280, force: bool = False, arxiv_id: str | None = None, source_url: str | None = None) -> dict[str, str]:
        """Render page 1 and, when detected, Figure 1 in a worker thread."""
        import asyncio

        structured_figures = None
        figure_destinations = [self.settings.managed_path(self.thumbnail_relative_path(sha256, f"figure-{number}")) for number in range(1, 4)]
        if arxiv_id and (force or any(not path.exists() for path in figure_destinations)):
            structured_figures = await self._fetch_structured_figures(_versioned_arxiv_id(arxiv_id, source_url))
        return await asyncio.to_thread(self._create_thumbnails_sync, relative_pdf_path, sha256, width, force, structured_figures)

    async def create_thumbnail(self, relative_pdf_path: str, sha256: str, *, width: int = 1280) -> str:
        """Compatibility helper returning the default available thumbnail."""
        paths = await self.create_thumbnails(relative_pdf_path, sha256, width=width)
        return paths.get("figure-1", paths["page-1"])

    def thumbnail_relative_path(self, sha256: str, source: str = "figure-1") -> str:
        if source not in {"page-1", "figure-1", "figure-2", "figure-3"}:
            raise ValueError("Unknown thumbnail source")
        return str(Path("thumbnails") / sha256[:2] / sha256 / f"{source}.png")

    CARD_MAX_WIDTH = 1200
    CARD_JPEG_QUALITY = 74

    def card_variant(self, thumbnail: Path) -> Path:
        """Lightweight JPEG copy of a thumbnail, for timeline cards.

        The full-resolution PNGs run 350 KB–4 MB each; a timeline of 60+ papers
        therefore shipped >100 MB of images and felt frozen on load. The card
        copy is ~8x smaller, cached beside its source, and rebuilt whenever the
        source PNG is newer. Falls back to the PNG if rendering fails.
        """
        destination = thumbnail.with_suffix(".card.jpg")
        if destination.exists() and destination.stat().st_mtime >= thumbnail.stat().st_mtime:
            return destination
        try:
            pixmap = fitz.Pixmap(thumbnail)
            if pixmap.alpha or (pixmap.colorspace and pixmap.colorspace.n > 3):
                pixmap = fitz.Pixmap(fitz.csRGB, pixmap)
            while pixmap.width > self.CARD_MAX_WIDTH:
                pixmap.shrink(1)
            destination.write_bytes(pixmap.tobytes("jpg", jpg_quality=self.CARD_JPEG_QUALITY))
        except Exception:  # noqa: BLE001 - a missing card copy only costs bandwidth
            return thumbnail
        return destination

    def image_regions(self, relative_pdf_path: str) -> list[dict]:
        """Per-page clickable image/figure boxes, normalized to 0..1 of the page.

        Combines embedded raster image boxes with the caption-anchored figure
        crops (which also catch vector figures). Coordinates match the reader's
        top-left fractional annotation rects, so a click can be saved directly
        as a rectangle annotation.
        """
        pdf_path = self.settings.managed_path(relative_pdf_path)
        regions: list[dict] = []
        with fitz.open(pdf_path) as document:
            detected: list[tuple[int, fitz.Rect]] = []
            for number in range(1, 4):
                found = self._find_figure(document, number)
                if found:
                    detected.append(found)
            for page_number in range(document.page_count):
                page = document.load_page(page_number)
                page_width, page_height = page.rect.width, page.rect.height
                if page_width <= 0 or page_height <= 0:
                    continue
                boxes = [fitz.Rect(info["bbox"]) for info in page.get_image_info()]
                boxes += [rect for pno, rect in detected if pno == page_number]
                kept: list[fitz.Rect] = []
                for box in boxes:
                    if box.is_empty or box.width < page_width * 0.06 or box.height < page_height * 0.04:
                        continue
                    if any(_rect_iou(box, other) > 0.6 for other in kept):
                        continue
                    kept.append(box)
                for box in kept:
                    x0 = min(max(box.x0, 0.0), page_width)
                    y0 = min(max(box.y0, 0.0), page_height)
                    regions.append({
                        "page_number": page_number + 1,
                        "x": x0 / page_width,
                        "y": y0 / page_height,
                        "width": min(box.x1, page_width) / page_width - x0 / page_width,
                        "height": min(box.y1, page_height) / page_height - y0 / page_height,
                    })
        return regions

    def _create_thumbnails_sync(self, relative_pdf_path: str, sha256: str, width: int, force: bool = False, structured_figures: dict[int, list[bytes]] | None = None) -> dict[str, str]:
        pdf_path = self.settings.managed_path(relative_pdf_path)
        paths: dict[str, str] = {}
        with fitz.open(pdf_path) as document:
            page_relative = self.thumbnail_relative_path(sha256, "page-1")
            page_destination = self.settings.managed_path(page_relative)
            self._render_thumbnail(document.load_page(0), page_destination, width, force=force)
            paths["page-1"] = page_relative

            for number in range(1, 4):
                source_name = f"figure-{number}"
                figure_relative = self.thumbnail_relative_path(sha256, source_name)
                figure_destination = self.settings.managed_path(figure_relative)
                if force:
                    figure_destination.unlink(missing_ok=True)
                structured = (structured_figures or {}).get(number)
                if structured:
                    self._render_structured_figure(structured, figure_destination, width, force)
                    paths[source_name] = figure_relative
                    continue
                figure = self._find_figure(document, number)
                if figure:
                    page_number, crop = figure
                    self._render_thumbnail(document.load_page(page_number), figure_destination, width, crop, force=force)
                    paths[source_name] = figure_relative
        return paths

    async def _fetch_structured_figures(self, arxiv_id: str) -> dict[int, list[bytes]]:
        sources = [
            f"https://arxiv.org/html/{arxiv_id}",
            f"https://ar5iv.labs.arxiv.org/html/{arxiv_id}",
        ]
        try:
            async with httpx.AsyncClient(timeout=self.settings.request_timeout, follow_redirects=True) as client:
                results: dict[int, list[bytes]] = {}
                for base_url in sources:
                    try:
                        response = await client.get(base_url, headers={"User-Agent": self.settings.user_agent})
                        response.raise_for_status()
                        parser = _StructuredFigureParser()
                        parser.feed(response.text)
                        for number in range(1, 4):
                            if number in results:
                                continue
                            images: list[bytes] = []
                            for url in parser.figure_urls(number, str(response.url)):
                                image = await client.get(url, headers={"User-Agent": self.settings.user_agent})
                                image.raise_for_status()
                                if not image.headers.get("content-type", "").casefold().startswith("image/"):
                                    raise ValueError("Structured figure URL did not return an image")
                                if len(image.content) > 20 * 1024 * 1024:
                                    raise ValueError("Structured figure image is too large")
                                with fitz.open(stream=image.content) as source:
                                    if source.page_count != 1:
                                        raise ValueError("Invalid structured figure image")
                                images.append(image.content)
                            if images:
                                results[number] = images
                    except (httpx.HTTPError, ValueError, fitz.FileDataError):
                        continue
                return results
        except (httpx.HTTPError, ValueError, fitz.FileDataError):
            return {}
    def _render_structured_figure(self, images: list[bytes], destination: Path, width: int, force: bool) -> None:
        if destination.exists() and not force:
            return
        dimensions: list[tuple[bytes, float, float]] = []
        for image in images:
            pixmap = fitz.Pixmap(image)
            dimensions.append((image, float(pixmap.width), float(pixmap.height)))
        max_height = max(height for _image, _width, height in dimensions)
        gap = max_height * 0.025 if len(dimensions) > 1 else 0
        canvas_width = sum(item_width for _image, item_width, _height in dimensions) + gap * (len(dimensions) - 1)
        canvas = fitz.open()
        page = canvas.new_page(width=canvas_width, height=max_height)
        x = 0.0
        for image, image_width, image_height in dimensions:
            y = (max_height - image_height) / 2
            page.insert_image(fitz.Rect(x, y, x + image_width, y + image_height), stream=image)
            x += image_width + gap
        try:
            # Structured HTML already provides a raster asset at its intended
            # resolution. Preserve those native pixels instead of forcing all
            # figures through the smaller timeline-thumbnail width.
            self._render_thumbnail(page, destination, round(canvas_width), force=True)
        finally:
            canvas.close()

    def _render_thumbnail(self, page: fitz.Page, destination: Path, width: int, clip: fitz.Rect | None = None, force: bool = False) -> None:
        if destination.exists() and not force:
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".tmp.png")
        area = clip or page.rect
        scale = width / area.width
        try:
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=area, alpha=False)
            pixmap.save(temporary)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    def _find_figure(self, document: fitz.Document, figure_number: int) -> tuple[int, fitz.Rect] | None:
        caption_pattern = re.compile(rf"^\s*(?:figure|fig\.?)[\s\u00a0]*{figure_number}(?:\s|[.:—-])", re.I)
        for page_number in range(document.page_count):
            page = document.load_page(page_number)
            blocks = page.get_text("dict").get("blocks", [])
            caption = None
            for block in blocks:
                if block.get("type") != 0:
                    continue
                text = " ".join(
                    span.get("text", "")
                    for line in block.get("lines", [])
                    for span in line.get("spans", [])
                ).strip()
                if caption_pattern.match(text):
                    caption = fitz.Rect(block["bbox"])
                    break
            if caption is None:
                continue
            crop = self._figure_crop(page, blocks, caption)
            if crop.width >= 80 and crop.height >= 60:
                return page_number, crop
        return None

    def _find_figure_one(self, document: fitz.Document) -> tuple[int, fitz.Rect] | None:
        return self._find_figure(document, 1)

    def _figure_crop(self, page: fitz.Page, blocks: list[dict], caption: fitz.Rect) -> fitz.Rect:
        page_rect = page.rect
        # Caption width reveals whether the figure belongs to one column or spans
        # the page. It also gives us conservative horizontal search bounds.
        single_column = caption.width < page_rect.width * 0.72
        if single_column:
            margin = page_rect.width * 0.035
            left = max(page_rect.x0, caption.x0 - margin)
            right = min(page_rect.x1, caption.x1 + margin)
        else:
            left = page_rect.x0 + page_rect.width * 0.04
            right = page_rect.x1 - page_rect.width * 0.04

        visual_boxes: list[fitz.Rect] = []
        for block in blocks:
            if block.get("type") != 1:
                continue
            box = fitz.Rect(block["bbox"])
            horizontal_overlap = min(box.x1, right) - max(box.x0, left)
            if box.y1 <= caption.y0 + 4 and horizontal_overlap > min(box.width, right - left) * 0.35:
                visual_boxes.append(box)

        # Many academic figures are vectors rather than embedded bitmap image
        # blocks. Treat their drawing paths as visual elements and cluster them
        # into a figure instead of falling back to a coarse page-band crop.
        for drawing in page.get_drawings():
            box = fitz.Rect(drawing["rect"])
            if box.is_empty or box.y1 > caption.y0 + 4:
                continue
            if box.width > page_rect.width * 0.75 and box.height < 5:
                continue  # page/header rule, not figure content
            horizontal_overlap = min(box.x1, right) - max(box.x0, left)
            if horizontal_overlap > 0 and caption.y0 - box.y1 < page_rect.height * 0.48:
                visual_boxes.append(box)

        all_clusters = self._cluster_visual_boxes(visual_boxes, gap=max(10, page_rect.width * 0.018))
        clusters = [
            box for box in all_clusters
            if box.width >= 50 and box.height >= 35 and caption.y0 - box.y1 < page_rect.height * 0.35
        ]
        if clusters:
            # Prefer substantial clusters close to the caption. This avoids
            # selecting isolated rules, logos, or diagrams earlier on the page.
            visual = max(
                clusters,
                key=lambda box: box.get_area() / page_rect.get_area() - max(0, caption.y0 - box.y1) / page_rect.height * 0.18,
            )
            # Multi-stage diagrams are commonly built from separate vector
            # groups with whitespace between them. Grow from the strongest
            # cluster through nearby siblings in the same vertical band rather
            # than mistaking the first stage for the complete figure.
            siblings = [
                box for box in all_clusters
                if box.width >= 30 and box.height >= 20
                and caption.y0 - box.y1 < page_rect.height * 0.35
            ]
            selected = [visual]
            changed = True
            while changed:
                changed = False
                combined = selected[0]
                for box in selected[1:]:
                    combined = combined | box
                for box in siblings:
                    if any(box == chosen for chosen in selected):
                        continue
                    horizontal_gap = max(0, combined.x0 - box.x1, box.x0 - combined.x1)
                    vertical_overlap = min(combined.y1, box.y1) - max(combined.y0, box.y0)
                    same_band = vertical_overlap > min(combined.height, box.height) * 0.2
                    if horizontal_gap <= page_rect.width * 0.12 and same_band:
                        selected.append(box)
                        changed = True
            for box in selected[1:]:
                visual = visual | box

            # Axis labels, panel headings, and legends are often PDF text rather
            # than drawing paths. Fold nearby text blocks into the visual bounds
            # while staying above the caption and inside this figure's column.
            label_padding = max(28, visual.height * 0.3)
            label_top = visual.y0 - label_padding
            label_bottom = min(caption.y0 - 3, visual.y1 + label_padding)
            for block in blocks:
                if block.get("type") != 0:
                    continue
                box = fitz.Rect(block["bbox"])
                if box == caption or box.y1 < label_top or box.y0 > label_bottom:
                    continue
                # A multi-line block entirely above the graphic is prose, not
                # a panel label. Multi-line tables inside the visual bounds are
                # retained, as are short headings just above a panel.
                if len(block.get("lines", [])) > 2 and box.y1 < visual.y0:
                    continue
                horizontal_overlap = min(box.x1, right) - max(box.x0, left)
                if horizontal_overlap > min(box.width, right - left) * 0.35:
                    visual = visual | box

            padding = max(8, min(14, visual.height * 0.14))
            left = max(page_rect.x0, visual.x0 - padding)
            right = min(page_rect.x1, visual.x1 + padding)
            top = max(page_rect.y0, visual.y0 - padding)
            bottom = min(caption.y0 - 3, visual.y1 + padding)
        else:
            # Vector figures have no image block. Use a conservative band above
            # the caption; this is intentionally best-effort and user-switchable.
            top = max(page_rect.y0, caption.y0 - page_rect.height * 0.38)
            bottom = max(top + 1, caption.y0 - 3)
        return fitz.Rect(left, top, right, bottom) & page_rect

    @staticmethod
    def _cluster_visual_boxes(boxes: list[fitz.Rect], gap: float) -> list[fitz.Rect]:
        clusters: list[fitz.Rect] = []
        for box in boxes:
            expanded = fitz.Rect(box.x0 - gap, box.y0 - gap, box.x1 + gap, box.y1 + gap)
            touching = [index for index, cluster in enumerate(clusters) if expanded.intersects(cluster)]
            if not touching:
                clusters.append(fitz.Rect(box))
                continue
            combined = fitz.Rect(box)
            for index in reversed(touching):
                combined = combined | clusters.pop(index)
            clusters.append(combined)

        # A merge can connect clusters added earlier through a later bridge.
        changed = True
        while changed:
            changed = False
            for left_index in range(len(clusters)):
                expanded = fitz.Rect(
                    clusters[left_index].x0 - gap, clusters[left_index].y0 - gap,
                    clusters[left_index].x1 + gap, clusters[left_index].y1 + gap,
                )
                for right_index in range(left_index + 1, len(clusters)):
                    if expanded.intersects(clusters[right_index]):
                        clusters[left_index] = clusters[left_index] | clusters.pop(right_index)
                        changed = True
                        break
                if changed:
                    break
        return clusters

    async def _download_one(self, url: str) -> DownloadedFile | None:
        headers = {"User-Agent": self.settings.user_agent, "Accept": "application/pdf"}
        fd, temporary_name = tempfile.mkstemp(prefix="download-", suffix=".pdf", dir=self.settings.tmp_dir)
        os.close(fd)
        temporary = Path(temporary_name)
        digest = hashlib.sha256()
        size = 0
        try:
            async with httpx.AsyncClient(timeout=self.settings.request_timeout, headers=headers, transport=self.transport, follow_redirects=True) as client:
                async with client.stream("GET", url) as response:
                    response.raise_for_status()
                    with temporary.open("wb") as output:
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            if size > self.settings.max_pdf_bytes:
                                raise ValueError("PDF exceeds configured size limit")
                            digest.update(chunk)
                            output.write(chunk)
            if size < 5 or temporary.read_bytes()[:5] != b"%PDF-":
                raise ValueError("Response is not a PDF")
            with fitz.open(temporary) as document:
                if document.page_count < 1:
                    raise ValueError("PDF contains no pages")
            sha256 = digest.hexdigest()
            relative = Path("files") / sha256[:2] / f"{sha256}.pdf"
            destination = self.settings.managed_path(relative)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                temporary.unlink()
            else:
                temporary.replace(destination)
            return DownloadedFile(str(relative), sha256, size, url)
        finally:
            temporary.unlink(missing_ok=True)


def _rect_iou(a: fitz.Rect, b: fitz.Rect) -> float:
    """Intersection-over-union of two rectangles (0 when they do not overlap)."""
    intersection = a & b
    if intersection.is_empty:
        return 0.0
    inter_area = intersection.width * intersection.height
    union_area = a.width * a.height + b.width * b.height - inter_area
    return inter_area / union_area if union_area > 0 else 0.0


def _versioned_arxiv_id(arxiv_id: str, source_url: str | None = None) -> str:
    if source_url:
        match = re.search(r"arxiv\.org/(?:abs|pdf)/([^/?#]+)", source_url, re.I)
        if match:
            return re.sub(r"\.pdf$", "", match.group(1), flags=re.I)
    return arxiv_id
