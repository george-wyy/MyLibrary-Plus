from __future__ import annotations

import asyncio
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from .config import Settings
from .services.library import AmbiguousMatch, LibraryService


URL_RE = re.compile(r"https?://[^\s<>\])]+", re.I)
MARKDOWN_URL_RE = re.compile(r"\[[^\]]*\]\((https?://[^)]+)\)", re.I)
LIST_PREFIX_RE = re.compile(r"^\s*(?:[-*•]+|\d+[.)])\s*")
TRACKING_PARAMS = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"}


def extract_paper_queries(text: str, entity_urls: list[str] | None = None) -> list[str]:
    """Extract URLs or one title per line from a Telegram message."""
    queries: list[str] = []
    linked_urls = entity_urls or []
    for url in linked_urls:
        queries.append(_clean_url(url))
    for raw_line in text.splitlines():
        line = LIST_PREFIX_RE.sub("", raw_line).strip()
        if not line or line.startswith("/"):
            continue
        urls = MARKDOWN_URL_RE.findall(line)
        if not urls:
            urls = URL_RE.findall(line)
        if urls:
            queries.extend(_clean_url(url.rstrip(".,;")) for url in urls)
            continue
        if linked_urls:
            # Telegram removes a formatted link target from visible text and
            # exposes it through a text_link entity. Do not also search the
            # visible label as a second paper.
            continue
        # Avoid treating headings such as "Papers:" as title searches.
        if line.endswith(":") and len(line.split()) <= 4:
            continue
        queries.append(line)
    return list(dict.fromkeys(query for query in queries if query))


def _clean_url(value: str) -> str:
    parts = urlsplit(value.strip())
    query = urlencode([(key, val) for key, val in parse_qsl(parts.query, keep_blank_values=True) if key.casefold() not in TRACKING_PARAMS])
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))


@dataclass
class ImportSummary:
    added: list[str]
    updated: list[str]
    no_pdf: list[str]
    errors: list[str]

    def message(self) -> str:
        lines = [f"Finished: {len(self.added)} added, {len(self.updated)} re-added, {len(self.errors)} failed."]
        if self.added:
            lines.append("\nAdded:\n" + "\n".join(f"✓ {title}" for title in self.added))
        if self.updated:
            lines.append("\nRe-added to timeline:\n" + "\n".join(f"• {title}" for title in self.updated))
        if self.no_pdf:
            lines.append("\nNo open PDF found:\n" + "\n".join(f"• {title}" for title in self.no_pdf))
        if self.errors:
            lines.append("\nFailed:\n" + "\n".join(f"✗ {error}" for error in self.errors))
        return "\n".join(lines)


class TelegramBot:
    def __init__(self, token: str, allowed_users: set[int], settings: Settings) -> None:
        if not token.strip():
            raise ValueError("Telegram bot token is empty")
        if not allowed_users:
            raise ValueError("At least one allowed Telegram user ID is required")
        self.base_url = f"https://api.telegram.org/bot{token.strip()}"
        self._token = token.strip()
        self.allowed_users = allowed_users
        self.settings = settings
        self.library = LibraryService(settings)
        self.state_path = settings.data_dir / "telegram-state.json"
        self.log_path = settings.logs_dir / "telegram.log"
        self.logger = _telegram_logger(self.log_path)
        self.offset = self._load_offset()

    async def run(self) -> None:
        timeout = httpx.Timeout(40.0, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": self.settings.user_agent}) as client:
            identity = await self._call(client, "getMe")
            print(f"Telegram bot @{identity.get('username', identity.get('first_name', 'unknown'))} is listening. Press Ctrl+C to stop.")
            print(f"Telegram log: {self.log_path}")
            self.logger.info("bot_started username=@%s allowed_users=%s offset=%s", identity.get("username", "unknown"), sorted(self.allowed_users), self.offset)
            while True:
                try:
                    updates = await self._call(client, "getUpdates", {
                        "offset": self.offset,
                        "timeout": 30,
                        "allowed_updates": ["message"],
                    })
                    for update in updates:
                        await self._handle_update(client, update)
                        self.offset = int(update["update_id"]) + 1
                        self._save_offset()
                except (httpx.HTTPError, TelegramAPIError) as error:
                    safe_error = self._safe_error(error)
                    self.logger.error("connection_error type=%s error=%s retry_seconds=5", type(error).__name__, safe_error)
                    print(f"Telegram connection error: {safe_error}. Retrying in 5 seconds.")
                    await asyncio.sleep(5)

    async def _handle_update(self, client: httpx.AsyncClient, update: dict) -> None:
        message = update.get("message") or {}
        text = message.get("text") or message.get("caption")
        if not text:
            self.logger.debug("update_ignored update_id=%s reason=no_text", update.get("update_id"))
            return
        chat_id = message.get("chat", {}).get("id")
        user_id = message.get("from", {}).get("id")
        if chat_id is None or user_id is None:
            self.logger.debug("update_ignored update_id=%s reason=missing_sender_or_chat", update.get("update_id"))
            return
        self.logger.info(
            "incoming update_id=%s user_id=%s chat_id=%s text=%r",
            update.get("update_id"), user_id, chat_id, text,
        )
        if int(user_id) not in self.allowed_users:
            self.logger.warning("unauthorized user_id=%s chat_id=%s", user_id, chat_id)
            await self._send(client, chat_id, f"This bot is private. Your Telegram user ID is {user_id}.")
            return
        command = text.strip().split(maxsplit=1)[0].split("@", 1)[0].casefold()
        if command in {"/start", "/help"}:
            await self._send(client, chat_id, HELP_TEXT)
            return
        if command == "/status":
            papers = self.library.list_papers()
            await self._send(client, chat_id, f"MyLibrary contains {len(papers)} papers; {sum(p.is_done for p in papers)} marked read.")
            return

        entity_urls = [entity["url"] for entity in message.get("entities", []) if entity.get("type") == "text_link" and entity.get("url")]
        queries = extract_paper_queries(text, entity_urls)
        if not queries:
            await self._send(client, chat_id, "I could not find a paper title or URL. Send one paper per line.")
            return
        if len(queries) > 30:
            await self._send(client, chat_id, "Please send no more than 30 papers in one message.")
            return
        await self._send(client, chat_id, f"Adding {len(queries)} paper{'s' if len(queries) != 1 else ''}…")
        self.logger.info("import_started update_id=%s count=%s queries=%r", update.get("update_id"), len(queries), queries)
        summary = await self._import(queries)
        self.logger.info(
            "import_finished update_id=%s added=%s existing=%s no_pdf=%s errors=%s",
            update.get("update_id"), len(summary.added), len(summary.updated), len(summary.no_pdf), summary.errors,
        )
        await self._send(client, chat_id, summary.message())

    async def _import(self, queries: list[str]) -> ImportSummary:
        summary = ImportSummary([], [], [], [])
        for query in queries:
            try:
                result = await self.library.add(query)
                (summary.added if result.created else summary.updated).append(result.title)
                if not result.pdf_downloaded:
                    summary.no_pdf.append(result.title)
            except AmbiguousMatch:
                summary.errors.append(f"{query} — ambiguous title; send its URL or DOI")
            except Exception as error:
                safe_error = self._safe_error(error)
                self.logger.error("paper_import_failed query=%r type=%s error=%s", query, type(error).__name__, safe_error)
                summary.errors.append(f"{query} — {safe_error[:180]}")
        return summary

    async def _send(self, client: httpx.AsyncClient, chat_id: int, text: str) -> None:
        # Telegram sendMessage accepts at most 4096 characters. Keep headroom
        # and send plain text so paper titles require no escaping.
        for start in range(0, len(text), 3900):
            chunk = text[start:start + 3900]
            self.logger.info("outgoing chat_id=%s text=%r", chat_id, chunk)
            await self._call(client, "sendMessage", {"chat_id": chat_id, "text": chunk})

    async def _call(self, client: httpx.AsyncClient, method: str, payload: dict | None = None):  # type: ignore[no-untyped-def]
        response = await client.post(f"{self.base_url}/{method}", json=payload or {})
        response.raise_for_status()
        body = response.json()
        if not body.get("ok"):
            raise TelegramAPIError(body.get("description", "Unknown Telegram API error"))
        return body.get("result")

    def _load_offset(self) -> int:
        try:
            return int(json.loads(self.state_path.read_text(encoding="utf-8")).get("offset", 0))
        except (FileNotFoundError, ValueError, TypeError, json.JSONDecodeError):
            return 0

    def _save_offset(self) -> None:
        self.settings.initialize()
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"offset": self.offset}), encoding="utf-8")
        temporary.replace(self.state_path)
        self.logger.debug("offset_saved offset=%s", self.offset)

    def _safe_error(self, error: Exception) -> str:
        return str(error).replace(self._token, "<redacted>")[:1000]


class TelegramAPIError(RuntimeError):
    pass


def _telegram_logger(path: Path) -> logging.Logger:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    logger = logging.getLogger(f"mylibrary.telegram.{path.resolve()}")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    if not logger.handlers:
        handler = RotatingFileHandler(path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%dT%H:%M:%S%z"))
        logger.addHandler(handler)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return logger


HELP_TEXT = """Send paper URLs, DOIs, arXiv IDs, or titles—one per line. MyLibrary will resolve metadata, download open PDFs, and create thumbnails.

Commands:
/status — show library totals
/help — show this message

For ambiguous papers, send an arXiv or publisher URL instead of only a title."""


async def discover_telegram_users(token: str, settings: Settings) -> list[tuple[int, str]]:
    """Return senders from pending messages without confirming the updates."""
    url = f"https://api.telegram.org/bot{token.strip()}/getUpdates"
    async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": settings.user_agent}) as client:
        response = await client.post(url, json={"timeout": 0, "allowed_updates": ["message"]})
        response.raise_for_status()
        body = response.json()
        if not body.get("ok"):
            raise TelegramAPIError(body.get("description", "Unknown Telegram API error"))
    users: dict[int, str] = {}
    for update in body.get("result", []):
        sender = (update.get("message") or {}).get("from") or {}
        if sender.get("id") is not None:
            label = " ".join(part for part in (sender.get("first_name"), sender.get("last_name")) if part)
            if sender.get("username"):
                label = f"{label} (@{sender['username']})".strip()
            users[int(sender["id"])] = label or "Unknown user"
    return sorted(users.items())
