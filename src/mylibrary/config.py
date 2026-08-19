from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def load_telegram_token() -> str:
    """Load the bot token without ever logging it; environment takes priority."""
    environment_token = os.environ.get("MYLIBRARY_TELEGRAM_TOKEN", "").strip()
    if environment_token:
        return environment_token
    token_path = PROJECT_ROOT / "api_keys" / ".telegram_bot"
    try:
        return token_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def load_telegram_allowed_users() -> set[int]:
    """Load numeric Telegram IDs from environment and the private allowlist file."""
    values: list[str] = []
    configured = os.environ.get("MYLIBRARY_TELEGRAM_ALLOWED_USERS", "")
    values.extend(configured.split(","))
    allowlist_path = PROJECT_ROOT / "api_keys" / ".telegram_users"
    try:
        values.extend(allowlist_path.read_text(encoding="utf-8").replace(",", "\n").splitlines())
    except FileNotFoundError:
        pass
    try:
        return {int(value.strip()) for value in values if value.strip() and not value.lstrip().startswith("#")}
    except ValueError as error:
        raise ValueError("Telegram allowed-user configuration must contain numeric IDs") from error


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    request_timeout: float = 20.0
    max_pdf_bytes: int = 100 * 1024 * 1024
    user_agent: str = "MyLibrary/0.1 (local research library)"

    @classmethod
    def create(cls, data_dir: Path | str | None = None) -> "Settings":
        selected = Path(data_dir) if data_dir is not None else PROJECT_ROOT / "data"
        return cls(data_dir=selected.expanduser().resolve())

    @property
    def database_path(self) -> Path:
        return self.data_dir / "library.sqlite3"

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"

    @property
    def tmp_dir(self) -> Path:
        return self.data_dir / "tmp"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def thumbnails_dir(self) -> Path:
        return self.data_dir / "thumbnails"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    def initialize(self) -> None:
        for path in (self.data_dir, self.files_dir, self.thumbnails_dir, self.tmp_dir, self.cache_dir, self.logs_dir):
            path.mkdir(parents=True, exist_ok=True)

    def managed_path(self, relative: str | Path) -> Path:
        path = (self.data_dir / relative).resolve()
        if not path.is_relative_to(self.data_dir):
            raise ValueError("Managed path escapes the configured data directory")
        return path
