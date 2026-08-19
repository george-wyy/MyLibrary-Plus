from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import Settings
from .models import Base


def create_db_engine(settings: Settings) -> Engine:
    settings.initialize()
    engine = create_engine(f"sqlite:///{settings.database_path}")

    @event.listens_for(engine, "connect")
    def configure_sqlite(dbapi_connection, _connection_record) -> None:  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    return engine


def initialize_database(engine: Engine) -> None:
    Base.metadata.create_all(engine)
    # create_all intentionally does not alter existing tables. Keep this small
    # self-contained app forward-compatible without requiring a migration CLI.
    columns = {column["name"] for column in inspect(engine).get_columns("papers")}
    if "is_done" not in columns:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE papers ADD COLUMN is_done BOOLEAN NOT NULL DEFAULT 0"))
    if "notes" not in columns:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE papers ADD COLUMN notes TEXT"))
    if "marker" not in columns:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE papers ADD COLUMN marker VARCHAR(20)"))
            connection.execute(text("UPDATE papers SET marker = 'check' WHERE is_done = 1"))
    if "thumbnail_source" not in columns:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE papers ADD COLUMN thumbnail_source VARCHAR(20) NOT NULL DEFAULT 'figure-1'"))
    if "citation_checked_at" not in columns:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE papers ADD COLUMN citation_checked_at DATETIME"))
            connection.execute(text(
                "UPDATE papers SET citation_checked_at = "
                "(SELECT MAX(retrieved_at) FROM citation_observations WHERE paper_id = papers.id)"
            ))
    annotation_columns = {column["name"] for column in inspect(engine).get_columns("annotations")}
    if "target_type" not in annotation_columns:
        with engine.begin() as connection:
            connection.execute(text(
                "ALTER TABLE annotations ADD COLUMN target_type VARCHAR(20) NOT NULL DEFAULT 'pdf'"
            ))
    if "anchor_json" not in annotation_columns:
        with engine.begin() as connection:
            connection.execute(text(
                "ALTER TABLE annotations ADD COLUMN anchor_json TEXT NOT NULL DEFAULT '{}'"
            ))
    with engine.begin() as connection:
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_papers_is_done ON papers (is_done)"))
        connection.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_annotations_target_type ON annotations (target_type)"
        ))
        # Existing libraries predate add history. Their original creation time
        # is the first add event; subsequent explicit adds append new rows.
        connection.execute(text(
            "INSERT OR IGNORE INTO paper_add_events (paper_id, added_at) "
            "SELECT id, created_at FROM papers "
            "WHERE NOT EXISTS (SELECT 1 FROM paper_add_events WHERE paper_id = papers.id)"
        ))


def session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(engine, expire_on_commit=False)


def session_scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    with factory() as session:
        yield session
