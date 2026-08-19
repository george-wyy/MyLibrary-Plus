from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Column, Date, DateTime, ForeignKey, Integer, String, Table, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


paper_tags = Table(
    "paper_tags",
    Base.metadata,
    Column("paper_id", ForeignKey("papers.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)


annotation_tags = Table(
    "annotation_tags",
    Base.metadata,
    Column("annotation_id", ForeignKey("annotations.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)


class Paper(Base):
    __tablename__ = "papers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(Text, index=True)
    normalized_title: Mapped[str] = mapped_column(Text, index=True)
    abstract: Mapped[str | None] = mapped_column(Text)
    year: Mapped[int | None] = mapped_column(Integer, index=True)
    publication_date: Mapped[date | None] = mapped_column(Date)
    venue: Mapped[str | None] = mapped_column(Text)
    volume: Mapped[str | None] = mapped_column(String(100))
    issue: Mapped[str | None] = mapped_column(String(100))
    pages: Mapped[str | None] = mapped_column(String(100))
    paper_type: Mapped[str | None] = mapped_column(String(100))
    doi: Mapped[str | None] = mapped_column(String(500), unique=True, index=True)
    arxiv_id: Mapped[str | None] = mapped_column(String(100), unique=True, index=True)
    pmid: Mapped[str | None] = mapped_column(String(100), unique=True, index=True)
    canonical_url: Mapped[str | None] = mapped_column(Text)
    metadata_source: Mapped[str | None] = mapped_column(String(100))
    metadata_raw: Mapped[str | None] = mapped_column(Text)
    provenance: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    thumbnail_source: Mapped[str] = mapped_column(String(20), default="figure-1", server_default="figure-1")
    marker: Mapped[str | None] = mapped_column(String(20))
    is_done: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", index=True)
    citation_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    authors: Mapped[list[PaperAuthor]] = relationship(
        back_populates="paper", cascade="all, delete-orphan", order_by="PaperAuthor.position"
    )
    identifiers: Mapped[list[Identifier]] = relationship(back_populates="paper", cascade="all, delete-orphan")
    files: Mapped[list[StoredFile]] = relationship(back_populates="paper", cascade="all, delete-orphan")
    tags: Mapped[list[Tag]] = relationship(secondary=paper_tags, back_populates="papers", order_by="Tag.name")
    citations: Mapped[list[CitationObservation]] = relationship(back_populates="paper", cascade="all, delete-orphan", order_by="CitationObservation.source")
    annotations: Mapped[list[Annotation]] = relationship(back_populates="paper", cascade="all, delete-orphan", order_by="Annotation.created_at")
    add_events: Mapped[list[PaperAddEvent]] = relationship(back_populates="paper", cascade="all, delete-orphan", order_by="PaperAddEvent.added_at")

    @property
    def latest_added_at(self) -> datetime:
        return self.add_events[-1].added_at if self.add_events else self.created_at


class PaperAddEvent(Base):
    __tablename__ = "paper_add_events"
    __table_args__ = (UniqueConstraint("paper_id", "added_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    paper: Mapped[Paper] = relationship(back_populates="add_events")


class Author(Base):
    __tablename__ = "authors"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text, index=True)
    given_name: Mapped[str | None] = mapped_column(Text)
    family_name: Mapped[str | None] = mapped_column(Text)
    orcid: Mapped[str | None] = mapped_column(String(100), index=True)
    papers: Mapped[list[PaperAuthor]] = relationship(back_populates="author")


class PaperAuthor(Base):
    __tablename__ = "paper_authors"
    __table_args__ = (UniqueConstraint("paper_id", "position"),)

    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("authors.id", ondelete="CASCADE"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer)
    paper: Mapped[Paper] = relationship(back_populates="authors")
    author: Mapped[Author] = relationship(back_populates="papers")


class Identifier(Base):
    __tablename__ = "identifiers"
    __table_args__ = (UniqueConstraint("scheme", "value"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    scheme: Mapped[str] = mapped_column(String(50), index=True)
    value: Mapped[str] = mapped_column(Text)
    paper: Mapped[Paper] = relationship(back_populates="identifiers")


class StoredFile(Base):
    __tablename__ = "files"

    id: Mapped[int] = mapped_column(primary_key=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    relative_path: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    mime_type: Mapped[str] = mapped_column(String(200), default="application/pdf")
    size_bytes: Mapped[int] = mapped_column(Integer)
    source_url: Mapped[str | None] = mapped_column(Text)
    is_primary: Mapped[bool] = mapped_column(default=True)
    downloaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    paper: Mapped[Paper] = relationship(back_populates="files")


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    normalized_name: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    papers: Mapped[list[Paper]] = relationship(secondary=paper_tags, back_populates="tags")
    annotations: Mapped[list[Annotation]] = relationship(
        secondary=annotation_tags, back_populates="tags"
    )


class CitationObservation(Base):
    __tablename__ = "citation_observations"
    __table_args__ = (UniqueConstraint("paper_id", "source"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(50), index=True)
    count: Mapped[int] = mapped_column(Integer)
    provider_work_id: Mapped[str | None] = mapped_column(Text)
    retrieved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    paper: Mapped[Paper] = relationship(back_populates="citations")


class Annotation(Base):
    __tablename__ = "annotations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), index=True)
    target_type: Mapped[str] = mapped_column(String(20), default="pdf", server_default="pdf", index=True)
    page_number: Mapped[int] = mapped_column(Integer)
    selected_text: Mapped[str] = mapped_column(Text)
    rects_json: Mapped[str] = mapped_column(Text)
    anchor_json: Mapped[str] = mapped_column(Text, default="{}", server_default="{}")
    color: Mapped[str] = mapped_column(String(20), default="yellow")
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    paper: Mapped[Paper] = relationship(back_populates="annotations")
    tags: Mapped[list[Tag]] = relationship(
        secondary=annotation_tags, back_populates="annotations", order_by="Tag.name"
    )
    replies: Mapped[list[AnnotationReply]] = relationship(
        back_populates="annotation", cascade="all, delete-orphan", order_by="AnnotationReply.created_at"
    )


class AnnotationReply(Base):
    __tablename__ = "annotation_replies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    annotation_id: Mapped[str] = mapped_column(ForeignKey("annotations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20), default="user", server_default="user")
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    annotation: Mapped[Annotation] = relationship(back_populates="replies")
