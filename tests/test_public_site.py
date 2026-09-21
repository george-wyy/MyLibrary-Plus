"""The GitHub Pages landing page must not rot.

public-site/ is published with GitHub Pages and its content root is the repo root
one level above it, so a reference like `../docs/images/timeline.png` in
public-site/zh/index.html really does resolve to <repo>/docs/images/timeline.png
in a browser. This test resolves every relative src/href the same way and fails
when one points at nothing — anchors, external URLs and mailto are ignored.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]
SITE = ROOT / "public-site"
PAGES = sorted(SITE.rglob("*.html"))
REFERENCE = re.compile(r'(?:src|href)\s*=\s*"([^"]+)"')


def _resolves(candidate: Path) -> bool:
    """True when the resolved reference exists — in this tree or in publish/overlay/.

    In the public repo (and on the published site) everything sits at the repo
    root. In the private authoring repo the docs screenshots and the site itself
    are overlay-only, so a reference the published site resolves correctly must
    not fail here. A reference that escapes the published root is, by definition,
    broken.
    """
    if not candidate.is_absolute():
        return False
    try:
        relative = candidate.relative_to(SITE)
    except ValueError:
        return False
    if ".." in relative.parts:
        return False
    # candidate is the real repo path; the overlay mirrors the published root.
    return candidate.exists() or (ROOT / "publish" / "overlay" / relative).exists()


def _internal_references(html: str) -> list[str]:
    references = []
    for raw in REFERENCE.findall(html):
        value = raw.strip()
        if not value or value.startswith(("#", "http://", "https://", "mailto:", "//")):
            continue
        references.append(value)
    return references


def test_the_site_has_both_languages() -> None:
    assert (SITE / "index.html").is_file(), "English landing page missing"
    assert (SITE / "zh" / "index.html").is_file(), "Chinese landing page missing"
    assert (SITE / "assets" / "style.css").is_file()
    assert (SITE / "assets" / "app.js").is_file()


@pytest.mark.parametrize("page", PAGES, ids=lambda path: str(path.relative_to(SITE)))
def test_every_relative_reference_resolves(page: Path) -> None:
    html = page.read_text(encoding="utf-8")
    references = _internal_references(html)
    assert references, f"{page.name} links to nothing at all"
    missing = []
    for reference in references:
        target = reference.split("#", 1)[0].split("?", 1)[0]
        if not target:
            continue
        # Browser semantics: the reference resolves against the published URL of this
        # page; public-site/ is that URL root, so resolving it in the checkout gives
        # the same file the visitor's browser would fetch.
        if not _resolves((page.parent / target).resolve()):
            missing.append(reference)
    assert not missing, f"{page.relative_to(ROOT)} has broken references: {missing}"


def test_pages_workflow_deploys_the_site_directory() -> None:
    # In the public repo the workflow is at .github/workflows/pages.yml; in the
    # private authoring repo it lives under publish/overlay/ until publish.sh
    # copies it out. Accept either so the check is meaningful in both trees.
    candidates = [
        ROOT / ".github" / "workflows" / "pages.yml",
        ROOT / "publish" / "overlay" / ".github" / "workflows" / "pages.yml",
    ]
    workflow = next((path for path in candidates if path.is_file()), None)
    assert workflow is not None, f"Pages deploy workflow missing (looked in {[str(p) for p in candidates]})"
    text = workflow.read_text(encoding="utf-8")
    assert "path: public-site" in text
    assert "actions/deploy-pages" in text


def test_landing_page_states_the_honest_bits() -> None:
    """Claims the project would be embarrassed to have to walk back."""
    for page in PAGES:
        text = page.read_text(encoding="utf-8")
        assert "127.0.0.1" in text, f"{page.name} must keep the no-auth/loopback warning"
        assert "examples/verify.py" in text, f"{page.name} must point at the checker"
