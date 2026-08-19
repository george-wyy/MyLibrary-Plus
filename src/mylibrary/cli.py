from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from typing import Annotated

import typer

from .config import Settings, load_telegram_allowed_users, load_telegram_token
from .services.library import AmbiguousMatch, LibraryService


app = typer.Typer(help="Manage a self-contained local research-paper library.", no_args_is_help=True)
tag_app = typer.Typer(help="Add, remove, and list paper tags.", no_args_is_help=True)
app.add_typer(tag_app, name="tag")
citation_app = typer.Typer(help="Update and compare citation counts.", no_args_is_help=True)
app.add_typer(citation_app, name="citations")
service_app = typer.Typer(help="Install and manage the systemd background service.", no_args_is_help=True)
app.add_typer(service_app, name="service")


TELEGRAM_TOKEN_HELP = """Telegram bot token not found.

Create the private configuration directory and token file:
  mkdir -p api_keys
  editor api_keys/.telegram_bot

Put only the token supplied by @BotFather in that file, for example:
  123456789:AAExampleBotToken

Then restrict access to the files:
  chmod 700 api_keys
  chmod 600 api_keys/.telegram_bot

After messaging the bot, find your numeric user ID with:
  ./mylibrary telegram --discover-users

Save each allowed numeric user ID on its own line in:
  api_keys/.telegram_users"""

TELEGRAM_USERS_HELP = """No allowed Telegram users are configured.

After sending a message to the bot, find your numeric user ID with:
  ./mylibrary telegram --discover-users

Create api_keys/.telegram_users and put one numeric user ID on each line, for example:
  123456789
  987654321

Then restrict access to the file:
  chmod 600 api_keys/.telegram_users

Alternatively, pass --allow-user USER_ID."""


def _service(data_dir: Path | None) -> LibraryService:
    return LibraryService(Settings.create(data_dir))


@app.command()
def init(data_dir: Annotated[Path | None, typer.Option(help="Override the repository-local data directory.")] = None) -> None:
    service = _service(data_dir)
    typer.echo(f"Initialized library at {service.settings.data_dir}")


@app.command()
def add(
    query: Annotated[str, typer.Argument(help="Paper title, URL, DOI, arXiv ID, or PMID.")],
    data_dir: Annotated[Path | None, typer.Option()] = None,
    author: Annotated[str | None, typer.Option(help="Optional author hint for title matching.")] = None,
    year: Annotated[int | None, typer.Option(help="Optional year hint for title matching.")] = None,
    no_pdf: Annotated[bool, typer.Option("--no-pdf", help="Add metadata without downloading a PDF.")] = False,
    json_output: Annotated[bool, typer.Option("--json", help="Print machine-readable output.")] = False,
) -> None:
    service = _service(data_dir)

    async def execute():  # type: ignore[no-untyped-def]
        try:
            return await service.add(query, author=author, year=year, download_pdf=not no_pdf)
        except AmbiguousMatch as error:
            if json_output or not sys.stdin.isatty():
                payload = [_candidate_json(candidate, index) for index, candidate in enumerate(error.candidates)]
                typer.echo(json.dumps({"status": "selection_required", "candidates": payload}, ensure_ascii=False))
                raise typer.Exit(2)
            typer.echo("Multiple possible matches found:\n")
            for index, candidate in enumerate(error.candidates[:10], start=1):
                names = ", ".join(author.name for author in candidate.authors[:3]) or "Unknown authors"
                typer.echo(f"[{index}] {candidate.title}\n    {names} · {candidate.year or 'n.d.'} · score {candidate.score:.2f}")
            selection = typer.prompt("Select a result (0 to cancel)", type=int, default=1)
            if selection == 0:
                raise typer.Abort()
            return await service.add(query, candidate_index=selection - 1, author=author, year=year, download_pdf=not no_pdf)

    result = asyncio.run(execute())
    if json_output:
        typer.echo(json.dumps(result.__dict__, ensure_ascii=False))
    else:
        typer.echo(f"{result.message} [{result.paper_id}]")


@app.command("list")
def list_command(
    data_dir: Annotated[Path | None, typer.Option()] = None,
    json_output: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    papers = _service(data_dir).list_papers()
    if json_output:
        typer.echo(json.dumps([_paper_json(paper) for paper in papers], ensure_ascii=False))
        return
    for paper in papers:
        marker = "PDF" if paper.files else "---"
        typer.echo(f"{paper.id[:8]}  {paper.year or '----'}  {marker}  {paper.title}")


@app.command()
def search(
    query: str,
    data_dir: Annotated[Path | None, typer.Option()] = None,
    json_output: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    papers = _service(data_dir).list_papers(query)
    if json_output:
        typer.echo(json.dumps([_paper_json(paper) for paper in papers], ensure_ascii=False))
    else:
        for paper in papers:
            typer.echo(f"{paper.id[:8]}  {paper.year or '----'}  {paper.title}")


@app.command()
def done(paper_id: str, data_dir: Annotated[Path | None, typer.Option()] = None) -> None:
    """Mark a paper as read."""
    service = _service(data_dir)
    paper = _find_by_prefix(service, paper_id)
    service.set_done(paper.id, True)
    typer.echo(f"Marked as read: {paper.title}")


@app.command()
def undone(paper_id: str, data_dir: Annotated[Path | None, typer.Option()] = None) -> None:
    """Mark a paper as not yet read."""
    service = _service(data_dir)
    paper = _find_by_prefix(service, paper_id)
    service.set_done(paper.id, False)
    typer.echo(f"Marked as unread: {paper.title}")


@app.command()
def mark(
    paper_id: Annotated[str, typer.Argument(help="Full or unique-prefix paper ID.")],
    marker: Annotated[str, typer.Argument(help="empty, thumbup, thumbdown, star, question, check, or wrong")],
    data_dir: Annotated[Path | None, typer.Option()] = None,
) -> None:
    """Set a paper's timeline marker."""
    service = _service(data_dir)
    paper = _find_by_prefix(service, paper_id)
    value = "" if marker.casefold() == "empty" else marker.casefold()
    try:
        updated = service.set_marker(paper.id, value)
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    typer.echo(f"Marker set to {updated.marker or 'empty'}: {paper.title}")


@app.command()
def notes(
    paper_id: Annotated[str, typer.Argument(help="Full or unique-prefix paper ID.")],
    text: Annotated[str, typer.Argument(help="Notes text; pass an empty string to clear it.")],
    data_dir: Annotated[Path | None, typer.Option()] = None,
) -> None:
    """Set or clear notes for a paper."""
    service = _service(data_dir)
    paper = _find_by_prefix(service, paper_id)
    updated = service.set_notes(paper.id, text)
    typer.echo(f"{'Updated' if updated.notes else 'Cleared'} notes: {paper.title}")


@app.command("thumbnail-source")
def thumbnail_source(
    paper_id: Annotated[str, typer.Argument(help="Full or unique-prefix paper ID.")],
    source: Annotated[str, typer.Argument(help="page-1, figure-1, figure-2, or figure-3")],
    data_dir: Annotated[Path | None, typer.Option()] = None,
) -> None:
    """Choose the thumbnail shown for a paper on the timeline."""
    service = _service(data_dir)
    paper = _find_by_prefix(service, paper_id)
    try:
        updated = service.set_thumbnail_source(paper.id, source.casefold())
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    typer.echo(f"Timeline thumbnail set to {updated.thumbnail_source}: {paper.title}")


@app.command()
def show(paper_id: str, data_dir: Annotated[Path | None, typer.Option()] = None) -> None:
    paper = _find_by_prefix(_service(data_dir), paper_id)
    typer.echo(json.dumps(_paper_json(paper, detailed=True), indent=2, ensure_ascii=False))


@app.command()
def open(paper_id: str, data_dir: Annotated[Path | None, typer.Option()] = None) -> None:
    service = _service(data_dir)
    paper = _find_by_prefix(service, paper_id)
    if not paper.files:
        raise typer.BadParameter("This paper has no stored PDF")
    path = service.settings.managed_path(paper.files[0].relative_path)
    if sys.platform == "darwin":
        subprocess.run(["open", str(path)], check=True)
    elif os.name == "nt":
        os.startfile(path)  # type: ignore[attr-defined]
    else:
        subprocess.run(["xdg-open", str(path)], check=True)


@app.command("fetch-pdf")
def fetch_pdf(paper_id: str, data_dir: Annotated[Path | None, typer.Option()] = None) -> None:
    service = _service(data_dir)
    paper = _find_by_prefix(service, paper_id)
    downloaded = asyncio.run(service.fetch_pdf(paper.id))
    typer.echo("PDF downloaded." if downloaded else "No openly accessible PDF was found.")


@app.command()
def thumbnails(
    data_dir: Annotated[Path | None, typer.Option()] = None,
    force: Annotated[bool, typer.Option(help="Regenerate thumbnails that already exist.")] = False,
) -> None:
    """Generate Page 1 and the first three figure thumbnails for stored PDFs."""
    generated, total = asyncio.run(_service(data_dir).generate_thumbnails(force=force))
    typer.echo(f"Generated {generated} thumbnails; {total} PDFs checked.")


@tag_app.command("add")
def tag_add(
    paper_id: Annotated[str, typer.Argument(help="Full or unique-prefix paper ID.")],
    name: Annotated[str, typer.Argument(help="Tag name.")],
    data_dir: Annotated[Path | None, typer.Option()] = None,
) -> None:
    service = _service(data_dir)
    paper = _find_by_prefix(service, paper_id)
    tag = service.add_tag(paper.id, name)
    typer.echo(f'Added tag "{tag.name}" to {paper.title}.')


@tag_app.command("remove")
def tag_remove(
    paper_id: str,
    name: str,
    data_dir: Annotated[Path | None, typer.Option()] = None,
) -> None:
    service = _service(data_dir)
    paper = _find_by_prefix(service, paper_id)
    match = next((tag for tag, _ in service.list_tags() if tag.normalized_name == name.casefold()), None)
    if match is None:
        raise typer.BadParameter("Tag not found")
    service.remove_tag(paper.id, match.id)
    typer.echo(f'Removed tag "{match.name}" from {paper.title}.')


@tag_app.command("list")
def tag_list(data_dir: Annotated[Path | None, typer.Option()] = None) -> None:
    for tag, count in _service(data_dir).list_tags():
        typer.echo(f"{tag.name}\t{count}")


@citation_app.command("update")
def citations_update(data_dir: Annotated[Path | None, typer.Option()] = None) -> None:
    """Refresh counts from OpenAlex, Semantic Scholar, and Crossref."""
    service = _service(data_dir)
    observations = asyncio.run(service.update_citations())
    papers = service.list_papers()
    typer.echo(f"Updated {len(observations)} observations across {len(papers)} papers.")
    for paper in papers:
        values = ", ".join(f"{item.source}={item.count}" for item in paper.citations) or "no coverage"
        best = max((item.count for item in paper.citations), default=None)
        typer.echo(f"{paper.title}\n  {values}" + (f"; max={best}" if best is not None else ""))


@citation_app.command("list")
def citations_list(data_dir: Annotated[Path | None, typer.Option()] = None) -> None:
    for paper in _service(data_dir).list_papers():
        values = ", ".join(f"{item.source}={item.count}" for item in paper.citations) or "no coverage"
        typer.echo(f"{paper.id[:8]}\t{values}\t{paper.title}")


@app.command()
def serve(
    data_dir: Annotated[Path | None, typer.Option()] = None,
    host: Annotated[str, typer.Option()] = "127.0.0.1",
    port: Annotated[int, typer.Option()] = 8765,
) -> None:
    import uvicorn
    from .web.app import create_app

    url = f"http://{host}:{port}"
    typer.echo(f"MyLibrary is available at {url}")
    typer.echo("Press Ctrl+C to stop the server.")
    uvicorn.run(create_app(Settings.create(data_dir)), host=host, port=port)


@app.command()
def run(
    data_dir: Annotated[Path | None, typer.Option()] = None,
    host: Annotated[str, typer.Option()] = "127.0.0.1",
    port: Annotated[int, typer.Option()] = 8765,
) -> None:
    """Run the local web GUI and private Telegram bot together."""
    import uvicorn

    from .telegram import TelegramBot
    from .services.citations import DailyCitationUpdater
    from .web.app import create_app

    settings = Settings.create(data_dir)
    telegram_access = _optional_telegram_access()
    server = uvicorn.Server(uvicorn.Config(create_app(settings), host=host, port=port, log_level="info"))
    bot = TelegramBot(telegram_access[0], telegram_access[1], settings) if telegram_access else None
    citation_updater = DailyCitationUpdater(LibraryService(settings), settings)

    async def run_both() -> None:
        server_task = asyncio.create_task(server.serve(), name="mylibrary-web")
        citation_task = asyncio.create_task(citation_updater.run(), name="mylibrary-citations")
        tasks = {server_task}
        if bot is not None:
            tasks.add(asyncio.create_task(bot.run(), name="mylibrary-telegram"))
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        citation_task.cancel()
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, citation_task, return_exceptions=True)
        for task in done:
            task.result()

    typer.echo(f"MyLibrary is available at http://{host}:{port}")
    if bot is not None:
        typer.echo("The Telegram bot and daily citation refresh will run in the same process. Press Ctrl+C to stop.")
    else:
        typer.echo("Telegram is not configured; continuing without the bot. Daily citation refresh is enabled. Press Ctrl+C to stop.")
    try:
        asyncio.run(run_both())
    except KeyboardInterrupt:
        typer.echo("MyLibrary stopped.")


@app.command()
def doctor(data_dir: Annotated[Path | None, typer.Option()] = None) -> None:
    service = _service(data_dir)
    database_ok = service.settings.database_path.exists()
    typer.echo(f"Project-local data: {service.settings.data_dir}")
    typer.echo(f"Database: {'ok' if database_ok else 'missing'}")
    typer.echo(f"Papers: {len(service.list_papers())}")


@service_app.command("print")
def service_print(
    user: Annotated[str | None, typer.Option(help="Non-root system account that will run MyLibrary.")] = None,
    host: Annotated[str, typer.Option()] = "127.0.0.1",
    port: Annotated[int, typer.Option()] = 8765,
) -> None:
    """Print the generated systemd unit without changing the system."""
    from .systemd import render_unit, service_account

    try:
        account, group = service_account(user)
        typer.echo(render_unit(account, group, host, port))
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error


@service_app.command("install")
def service_install(
    user: Annotated[str | None, typer.Option(help="Non-root system account that will run MyLibrary.")] = None,
    host: Annotated[str, typer.Option(help="Bind address; use 0.0.0.0 only on a trusted network.")] = "127.0.0.1",
    port: Annotated[int, typer.Option()] = 8765,
) -> None:
    """Generate, install, enable, and start the systemd service."""
    from .systemd import SYSTEMD_UNIT_PATH, install_service, render_unit, service_account

    try:
        account, group = service_account(user)
        install_service(render_unit(account, group, host, port), account)
    except (PermissionError, ValueError, subprocess.CalledProcessError) as error:
        raise typer.BadParameter(str(error)) from error
    typer.echo(f"Installed and started {SYSTEMD_UNIT_PATH} as {account}.")
    typer.echo(f"MyLibrary is listening on http://{host}:{port}")


@service_app.command("uninstall")
def service_uninstall() -> None:
    """Stop and remove the generated service without deleting library data."""
    from .systemd import SYSTEMD_UNIT_PATH, uninstall_service

    try:
        uninstall_service()
    except (PermissionError, ValueError, subprocess.CalledProcessError) as error:
        raise typer.BadParameter(str(error)) from error
    typer.echo(f"Removed {SYSTEMD_UNIT_PATH}. Library data and API keys were preserved.")


@service_app.command("status")
def service_status() -> None:
    """Show the systemd service status."""
    subprocess.run(["systemctl", "--no-pager", "--full", "status", "mylibrary.service"], check=False)


@service_app.command("logs")
def service_logs(
    follow: Annotated[bool, typer.Option("--follow", "-f", help="Continue following new log entries.")] = False,
    lines: Annotated[int, typer.Option("--lines", "-n", min=1)] = 100,
) -> None:
    """Show recent journal logs for MyLibrary."""
    command = ["journalctl", "--unit", "mylibrary.service", "--lines", str(lines), "--no-pager"]
    if follow:
        command.append("--follow")
    subprocess.run(command, check=False)


@app.command()
def telegram(
    data_dir: Annotated[Path | None, typer.Option()] = None,
    allow_user: Annotated[list[int] | None, typer.Option("--allow-user", help="Telegram numeric user ID allowed to use the bot; repeat for multiple users.")] = None,
    discover_users: Annotated[bool, typer.Option("--discover-users", help="Print user IDs from pending bot messages, then exit.")] = False,
) -> None:
    """Run the private Telegram paper-import bot using long polling."""
    from .telegram import TelegramBot, discover_telegram_users

    token = load_telegram_token()
    if not token:
        raise typer.BadParameter(TELEGRAM_TOKEN_HELP)
    settings = Settings.create(data_dir)
    if discover_users:
        users = asyncio.run(discover_telegram_users(token, settings))
        if users:
            for user_id, label in users:
                typer.echo(f"{user_id}\t{label}")
        else:
            typer.echo("No pending messages. Send /start to the bot in Telegram and try again.")
        return
    _, allowed = _telegram_access(allow_user)
    try:
        asyncio.run(TelegramBot(token, allowed, settings).run())
    except KeyboardInterrupt:
        typer.echo("Telegram bot stopped.")


def _telegram_access(extra_users: list[int] | None = None) -> tuple[str, set[int]]:
    token = load_telegram_token()
    if not token:
        raise typer.BadParameter(TELEGRAM_TOKEN_HELP)
    try:
        allowed = load_telegram_allowed_users()
        allowed.update(extra_users or [])
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    if not allowed:
        raise typer.BadParameter(TELEGRAM_USERS_HELP)
    return token, allowed


def _optional_telegram_access() -> tuple[str, set[int]] | None:
    """Return Telegram credentials when complete, otherwise disable the bot."""
    token = load_telegram_token()
    if not token:
        return None
    try:
        allowed = load_telegram_allowed_users()
    except ValueError:
        return None
    return (token, allowed) if allowed else None


def _find_by_prefix(service: LibraryService, value: str):  # type: ignore[no-untyped-def]
    exact = service.get_paper(value)
    if exact:
        return exact
    matches = [paper for paper in service.list_papers() if paper.id.startswith(value)]
    if len(matches) != 1:
        raise typer.BadParameter("Paper ID is missing or ambiguous")
    return service.get_paper(matches[0].id)


def _candidate_json(candidate, index: int) -> dict:  # type: ignore[no-untyped-def]
    return {"index": index, "title": candidate.title, "authors": [a.name for a in candidate.authors], "year": candidate.year, "doi": candidate.doi, "arxiv_id": candidate.arxiv_id, "score": candidate.score, "sources": candidate.sources}


def _paper_json(paper, detailed: bool = False) -> dict:  # type: ignore[no-untyped-def]
    result = {"id": paper.id, "title": paper.title, "authors": [link.author.name for link in paper.authors], "year": paper.year, "venue": paper.venue, "doi": paper.doi, "arxiv_id": paper.arxiv_id, "has_pdf": bool(paper.files), "done": paper.is_done, "marker": paper.marker, "notes": paper.notes, "thumbnail_source": paper.thumbnail_source, "tags": [tag.name for tag in paper.tags], "citation_count": max((item.count for item in paper.citations), default=None), "citations": {item.source: item.count for item in paper.citations}, "added_at": paper.latest_added_at.isoformat(), "first_added_at": paper.created_at.isoformat(), "add_history": [event.added_at.isoformat() for event in reversed(paper.add_events)], "updated_at": paper.updated_at.isoformat()}
    if detailed:
        result.update({"abstract": paper.abstract, "url": paper.canonical_url, "files": [item.relative_path for item in paper.files], "identifiers": {item.scheme: item.value for item in paper.identifiers}})
    return result


if __name__ == "__main__":
    app()
