from pathlib import Path

import pytest

from mylibrary.config import Settings
from mylibrary.telegram import ImportSummary, TelegramBot, extract_paper_queries


def test_extracts_multiline_urls_and_strips_tracking() -> None:
    text = """Papers:
1. TruthfulQA: https://arxiv.org/abs/2109.07958?utm_source=telegram
- https://arxiv.org/abs/2207.05221
"""
    assert extract_paper_queries(text) == [
        "https://arxiv.org/abs/2109.07958",
        "https://arxiv.org/abs/2207.05221",
    ]


def test_extracts_plain_titles_one_per_line() -> None:
    assert extract_paper_queries("Attention Is All You Need\nTruthfulQA") == [
        "Attention Is All You Need",
        "TruthfulQA",
    ]


def test_telegram_text_links_do_not_duplicate_visible_titles() -> None:
    assert extract_paper_queries(
        "TruthfulQA\nLanguage Models Know",
        ["https://arxiv.org/abs/2109.07958", "https://arxiv.org/abs/2207.05221"],
    ) == [
        "https://arxiv.org/abs/2109.07958",
        "https://arxiv.org/abs/2207.05221",
    ]


def test_bot_requires_an_allowlist(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="allowed Telegram user"):
        TelegramBot("token", set(), Settings.create(tmp_path / "data"))


def test_bot_log_is_private_and_errors_redact_token(tmp_path: Path) -> None:
    bot = TelegramBot("12345:very-secret-token-value", {123}, Settings.create(tmp_path / "data"))
    bot.logger.info("test_event")
    for handler in bot.logger.handlers:
        handler.flush()

    assert bot.log_path.exists()
    assert bot.log_path.stat().st_mode & 0o077 == 0
    assert "test_event" in bot.log_path.read_text(encoding="utf-8")
    assert bot._safe_error(RuntimeError("URL contains 12345:very-secret-token-value")) == "URL contains <redacted>"


def test_import_summary_is_readable() -> None:
    summary = ImportSummary(["New"], ["Existing"], ["New"], ["Bad — unavailable"])
    message = summary.message()
    assert "1 added, 1 re-added, 1 failed" in message
    assert "Re-added to timeline" in message
    assert "No open PDF found" in message
