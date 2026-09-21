"""The GitHub Pages landing page must not rot.

public-site/ is the Pages artifact root and it is self-contained: every relative
src/href in it must resolve to a file that ships with the artifact. This test
resolves every reference the way a browser would and fails when one points at
nothing — anchors, external URLs and mailto are ignored.

Runs under pytest (the repo's suite) and standalone (`python3
tests/test_public_site.py`), so the Pages deploy workflow needs no dependencies.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]
SITE = ROOT / "public-site"
PAGES = sorted(SITE.rglob("*.html"))
REFERENCE = re.compile(r'(?:src|href)\s*=\s*"([^"]+)"')


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


def check_every_relative_reference_resolves(page: Path) -> None:
    html = page.read_text(encoding="utf-8")
    references = _internal_references(html)
    assert references, f"{page.name} links to nothing at all"
    missing = []
    for reference in references:
        target = reference.split("#", 1)[0].split("?", 1)[0]
        if not target:
            continue
        # Browser semantics: the reference resolves against this page's URL, and
        # public-site/ is the URL root — so resolving it in the checkout gives the
        # same file the visitor's browser fetches. The artifact must therefore be
        # self-contained; nothing outside public-site/ is available on Pages.
        resolved = (page.parent / target).resolve()
        if SITE.resolve() not in resolved.parents and resolved != SITE.resolve():
            missing.append(f"{reference} (escapes the published root)")
        elif not resolved.exists():
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


# One test per page, so pytest names the failing page in its report. Written as a
# loop (rather than a fixture) because main() below runs the same functions with
# no pytest on the box at all.
def _make_page_check(page: Path):
    def _check() -> None:
        check_every_relative_reference_resolves(page)

    _check.__name__ = f"test_references_resolve_in_{page.parent.name}_{page.stem}"
    _check.__doc__ = f"Every relative src/href in {page.relative_to(SITE)} ships with the artifact."
    return _check


for _page in PAGES:
    globals()[f"test_references_resolve_{_page.parent.name}_{_page.stem}"] = _make_page_check(_page)


def main() -> int:
    """Standalone runner — the Pages workflow must not depend on pytest."""
    checks: list[tuple[str, object]] = [
        ("both languages present", test_the_site_has_both_languages),
        ("pages workflow present", test_pages_workflow_deploys_the_site_directory),
        ("honest claims kept", test_landing_page_states_the_honest_bits),
    ]
    for page in PAGES:
        checks.append((f"references resolve in {page.relative_to(SITE)}", _make_page_check(page)))
    failed = 0
    for label, check in checks:
        try:
            check()  # type: ignore[operator]
        except AssertionError as error:
            failed += 1
            print(f"FAIL  {label}\n      {error}")
        else:
            print(f"ok    {label}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
