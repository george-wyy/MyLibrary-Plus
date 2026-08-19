from pathlib import Path

import pytest

from mylibrary import systemd


def test_render_unit_uses_clone_path_and_safe_defaults(monkeypatch, tmp_path: Path) -> None:
    project = tmp_path / "My Library"
    monkeypatch.setattr(systemd, "PROJECT_ROOT", project)

    unit = systemd.render_unit("alice", "research", "127.0.0.1", 8765)

    assert systemd.GENERATED_MARKER in unit
    assert "User=alice" in unit
    assert "Group=research" in unit
    escaped_project = str(project).replace(" ", "\\x20")
    assert f"WorkingDirectory={escaped_project}" in unit
    assert f'ExecStart="{project / "mylibrary"}" run --host 127.0.0.1 --port 8765' in unit
    assert f"ReadWritePaths={escaped_project}/data" in unit
    assert "UMask=0077" in unit


@pytest.mark.parametrize("port", [0, 65536])
def test_render_unit_rejects_invalid_ports(port: int) -> None:
    with pytest.raises(ValueError, match="Port"):
        systemd.render_unit("alice", "research", port=port)


def test_render_unit_rejects_invalid_host() -> None:
    with pytest.raises(ValueError, match="Host"):
        systemd.render_unit("alice", "research", host="127.0.0.1 extra")
