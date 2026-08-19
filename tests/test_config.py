from pathlib import Path

import pytest

from mylibrary import cli, config


def test_telegram_token_environment_takes_precedence(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(config, "PROJECT_ROOT", tmp_path)
    token_file = tmp_path / "api_keys" / ".telegram_bot"
    token_file.parent.mkdir()
    token_file.write_text("file-token\n", encoding="utf-8")
    monkeypatch.setenv("MYLIBRARY_TELEGRAM_TOKEN", "environment-token")

    assert config.load_telegram_token() == "environment-token"


def test_telegram_token_falls_back_to_private_file(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(config, "PROJECT_ROOT", tmp_path)
    token_file = tmp_path / "api_keys" / ".telegram_bot"
    token_file.parent.mkdir()
    token_file.write_text("file-token\n", encoding="utf-8")
    monkeypatch.delenv("MYLIBRARY_TELEGRAM_TOKEN", raising=False)

    assert config.load_telegram_token() == "file-token"


def test_telegram_allowed_users_merge_file_and_environment(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(config, "PROJECT_ROOT", tmp_path)
    allowlist = tmp_path / "api_keys" / ".telegram_users"
    allowlist.parent.mkdir()
    allowlist.write_text("123\n# comment\n456\n", encoding="utf-8")
    monkeypatch.setenv("MYLIBRARY_TELEGRAM_ALLOWED_USERS", "789")

    assert config.load_telegram_allowed_users() == {123, 456, 789}


def test_combined_server_treats_telegram_as_optional(monkeypatch) -> None:
    monkeypatch.setattr(cli, "load_telegram_token", lambda: "")
    assert cli._optional_telegram_access() is None

    monkeypatch.setattr(cli, "load_telegram_token", lambda: "token")
    monkeypatch.setattr(cli, "load_telegram_allowed_users", lambda: set())
    assert cli._optional_telegram_access() is None

    monkeypatch.setattr(cli, "load_telegram_allowed_users", lambda: {123})
    assert cli._optional_telegram_access() == ("token", {123})


def test_explicit_telegram_command_explains_missing_configuration(monkeypatch) -> None:
    monkeypatch.setattr(cli, "load_telegram_token", lambda: "")
    with pytest.raises(Exception) as token_error:
        cli._telegram_access()
    assert "editor api_keys/.telegram_bot" in str(token_error.value)
    assert "api_keys/.telegram_users" in str(token_error.value)

    monkeypatch.setattr(cli, "load_telegram_token", lambda: "token")
    monkeypatch.setattr(cli, "load_telegram_allowed_users", lambda: set())
    with pytest.raises(Exception) as users_error:
        cli._telegram_access()
    assert "one numeric user ID on each line" in str(users_error.value)
