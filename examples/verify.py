#!/usr/bin/env python3
"""Smoke-test the bundled example library — for a human or an agent that has just
cloned the repo and wants to know the install works before touching real papers.

    python3 examples/verify.py            # needs no server; checks files + db + import
    python3 examples/verify.py --serve    # also boots the app on a free port and
                                          # hits every route the README advertises

Exits 0 when everything checks out, 1 with a list of failures otherwise. Nothing is
written outside a temporary directory and the app is stopped on the way out.
"""
from __future__ import annotations

import json
import re
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "examples" / "data"
PAPER_ID = "9f97e37b-408e-4fdb-a775-1a46ed222500"  # Attention Is All You Need
failures: list[str] = []


def python_executable() -> str:
    """Prefer the repo's virtualenv: the README's install step puts the app there,
    and a bare `python3` (e.g. macOS 3.9) cannot run it."""
    for candidate in (ROOT / ".venv" / "bin" / "python3", ROOT / ".venv" / "bin" / "python"):
        if candidate.is_file():
            return str(candidate)
    return sys.executable


PYTHON = python_executable()
CHILD_ENV = {"PATH": "/usr/bin:/bin:/usr/local/bin", "PYTHONPATH": str(ROOT / "src")}


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'}  {label}{f' — {detail}' if detail and not ok else ''}")
    if not ok:
        failures.append(f"{label}{f': {detail}' if detail else ''}")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def get(url: str) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def check_data() -> None:
    print("\n1. bundled data")
    check("examples/data/library.sqlite3 exists", (DATA / "library.sqlite3").is_file())
    with sqlite3.connect(f"file:{DATA / 'library.sqlite3'}?mode=ro", uri=True) as con:
        papers = con.execute("select count(*) from papers").fetchone()[0]
        annotations = con.execute("select count(*) from annotations").fetchone()[0]
        backed = con.execute(
            "select p.title, f.relative_path from papers p join files f on f.paper_id = p.id"
        ).fetchall()
    check("papers in the example database", papers >= 8, f"{papers} rows")
    check("annotations (PDF + lecture + one figure region)", annotations >= 5, f"{annotations} rows")
    # Only some papers ship their PDF (see examples/README.md); the rest are
    # metadata-only on purpose, so check the bundled ones and count the rest.
    bundled = []
    for title, relative in backed:
        path = DATA / relative
        if path.is_file():
            bundled.append((title, path))
        else:
            print(f"  note  PDF not bundled (metadata-only paper): {title}")
    check("bundled PDFs are real files", len(bundled) >= 4, f"{len(bundled)} of {len(backed)}")
    for title, path in bundled:
        check(f"PDF is readable: {title}", path.stat().st_size > 1000)

    lecture = DATA / "lectures" / f"{PAPER_ID}.md"
    variant = DATA / "lectures" / f"{PAPER_ID}__interactive.md"
    widget = DATA / "lectures" / "assets" / PAPER_ID / "softmax-temperature.html"
    check("main lecture present", lecture.is_file())
    check("second lecture variant present (<id>__interactive.md)", variant.is_file())
    check("widget component present", widget.is_file())
    notes = sorted((DATA / "notes").glob("*.md"))
    check("concept notes for [[wikilinks]]", len(notes) >= 2, f"{len(notes)} notes")


def check_import() -> None:
    print(f"\n2. the app imports and initialises a data dir  [{PYTHON}]")
    with tempfile.TemporaryDirectory() as tmp:
        data_dir = Path(tmp) / "data"
        init = subprocess.run(
            [PYTHON, "-m", "mylibrary.cli", "init", "--data-dir", str(data_dir)],
            cwd=ROOT, capture_output=True, text=True, env=CHILD_ENV,
        )
        check("mylibrary init", init.returncode == 0, (init.stderr or init.stdout).strip()[-300:])


def check_routes(port: int) -> None:
    print(f"\n3. live routes on http://127.0.0.1:{port}")
    base = f"http://127.0.0.1:{port}"
    lectures = [
        ("/", "the timeline"),
        (f"/paper/{PAPER_ID}", "a paper's metadata page"),
        (f"/paper/{PAPER_ID}/read", "the PDF reader"),
        (f"/paper/{PAPER_ID}/study", "the study view"),
        (f"/paper/{PAPER_ID}/figures", "figure regions for region annotations"),
        (f"/api/annotations", "every annotation in the library"),
        (f"/api/notes/self-attention", "a shared concept note"),
        ("/wiki", "the workflow wiki"),
    ]
    for route, label in lectures:
        status, _ = get(base + route)
        check(f"{label} ({route})", status == 200, f"HTTP {status}")

    status, body = get(base + f"/api/papers/{PAPER_ID}/lectures")
    variants = json.loads(body) if status == 200 else []
    check("lecture picker lists the main note + the variant",
          status == 200 and len(variants) >= 2, f"{variants}")
    status, body = get(base + f"/paper/{PAPER_ID}/lecture.md?variant=interactive")
    check("the variant lecture is served", status == 200 and b"```widget" in body, f"HTTP {status}")
    status, _ = get(base + f"/paper/{PAPER_ID}/lecture-asset/softmax-temperature.html")
    check("the widget component is served", status == 200, f"HTTP {status}")
    status, _ = get(base + f"/paper/{PAPER_ID}/lecture-asset/%2e%2e%2f%2e%2e%2fetc%2fpasswd")
    check("path traversal out of the asset dir is refused", status == 404, f"HTTP {status}")


def main() -> int:
    serve = "--serve" in sys.argv
    check_data()
    check_import()
    if serve:
        port = free_port()
        process = subprocess.Popen(
            [PYTHON, "-m", "mylibrary.cli", "serve", "--data-dir", str(DATA), "--port", str(port)],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=CHILD_ENV,
        )
        started = False
        try:
            for _ in range(40):
                time.sleep(0.5)
                if process.poll() is not None:
                    check("the app started", False, f"exited with {process.returncode}: {(process.stdout.read() or '')[-300:]}")
                    break
                try:
                    get(f"http://127.0.0.1:{port}/")
                    started = True
                    break
                except Exception:
                    continue
            else:
                check("the app started", False, "no response after 20s")
            if started:
                check_routes(port)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
    else:
        print("\n3. live routes — skipped (add --serve to boot the app on a free port)")

    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
