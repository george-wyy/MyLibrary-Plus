#!/usr/bin/env python3
"""Convert 1-bit (bilevel) images inside a PDF to 8-bit grayscale.

pdf.js 6.1.200 renders such images as blank - the page ends up showing only
its vector text, which is why some scanned PDFs come up almost empty in the
in-app reader while Chrome's built-in viewer shows them fine. Re-encoding
just those images to 8-bit leaves everything else (OCR text layer, JPEG
pages, page structure, outline) untouched.

Usage: fix_1bit_images.py INPUT.pdf OUTPUT.pdf [DPI] [JPEG_QUALITY]
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image


def convert(source: Path, target: Path, dpi: int = 150, quality: int = 80) -> tuple[int, int]:
    document = fitz.open(source)
    converted = 0
    inspected = 0

    seen: set[int] = set()
    for page in document:
        for image in page.get_images(full=True):
            xref = image[0]
            if xref in seen:
                continue
            seen.add(xref)
            inspected += 1
            # Read the depth off the PDF object itself. Going by the decoded
            # bitmap's mode does not work: PyMuPDF already expands a 1-bit
            # CCITT stream to 8-bit grayscale on extraction, so every image
            # would look like it needs no conversion.
            depth = document.xref_get_key(xref, "BitsPerComponent")
            if not (depth and depth[0] == "int" and depth[1] == "1"):
                continue
            # JPEG specifically, not PNG: both Pillow and PyMuPDF happily
            # re-compress a black-and-white bitmap back down to 1 bit when
            # writing PNG, which is the very thing being fixed here. JPEG has
            # no 1-bit mode, so the image is guaranteed to land as 8-bit -
            # and 8-bit JPEG pages in this same file already render fine.
            pixmap = fitz.Pixmap(document, xref)
            if pixmap.colorspace is None or pixmap.colorspace.n != 1:
                pixmap = fitz.Pixmap(fitz.csGRAY, pixmap)
            # Bilevel scans are usually 240+ dpi, which no screen shows and
            # 8-bit JPEG stores far less efficiently than CCITT did - left
            # alone the file balloons several-fold and each page takes many
            # seconds to paint. Downsampling to `dpi` keeps text crisp at
            # normal reading zoom while cutting both size and render time.
            # Effective dpi comes from how big the image is drawn on the page
            # (points/72 = inches), not from pixmap.xres, which a PDF image
            # stream generally does not carry.
            rects = page.get_image_rects(xref)
            drawn_width_inch = (rects[0].width / 72) if rects else 0
            effective_dpi = pixmap.width / drawn_width_inch if drawn_width_inch else 0
            if dpi and effective_dpi > dpi:
                factor = dpi / effective_dpi
                pixmap = fitz.Pixmap(
                    pixmap,
                    round(pixmap.width * factor),
                    round(pixmap.height * factor),
                    None,
                )
            page.replace_image(xref, stream=pixmap.tobytes("jpeg", jpg_quality=quality))
            converted += 1

    # garbage=3 rewrites the xref and drops the now-orphaned 1-bit streams.
    document.save(target, garbage=3, deflate=True)
    document.close()
    return converted, inspected


def main() -> int:
    if not 3 <= len(sys.argv) <= 5:
        print(__doc__)
        return 2
    source, target = Path(sys.argv[1]), Path(sys.argv[2])
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    quality = int(sys.argv[4]) if len(sys.argv) > 4 else 80
    converted, inspected = convert(source, target, dpi, quality)
    print(f"converted {converted} of {inspected} images to 8-bit grayscale")
    print(f"{source.stat().st_size:,} bytes -> {target.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
