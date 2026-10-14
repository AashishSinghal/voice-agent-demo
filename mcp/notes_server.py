"""Notes connector: an MCP server over a local SQLite file.

    python mcp/notes_server.py

Environment:
    NOTES_DB             database path (default ~/.voice-agent/notes.sqlite)
    MCP_GRANTED_SCOPES   comma-separated scopes this session may use
                         (default "notes:read": read-only unless told otherwise)

Scopes: notes:read (list, search, read), notes:write (create),
notes:delete (delete). Delete is destructive, so the brain asks the caller to
confirm before it runs.
"""

from __future__ import annotations

import os
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

from jsonrpc_server import McpServer, Tool, ToolError

MAX_TITLE = 120
MAX_BODY = 5000


def connect() -> sqlite3.Connection:
    path = Path(os.environ.get("NOTES_DB") or Path.home() / ".voice-agent" / "notes.sqlite")
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute(
        "CREATE TABLE IF NOT EXISTS notes ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)"
    )
    return db


def _like(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def resolve(db: sqlite3.Connection, ref: str) -> sqlite3.Row:
    """Find one note by id or title. Ambiguity is an error, never a guess: the
    destructive tool must not delete the wrong note because two titles match."""
    ref = ref.strip()
    if ref.isdigit():
        row = db.execute("SELECT * FROM notes WHERE id = ?", (int(ref),)).fetchone()
        if row:
            return row
    exact = db.execute("SELECT * FROM notes WHERE lower(title) = lower(?)", (ref,)).fetchall()
    if len(exact) == 1:
        return exact[0]
    rows = (
        exact
        or db.execute(
            "SELECT * FROM notes WHERE title LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 5", (_like(ref),)
        ).fetchall()
    )
    if not rows:
        raise ToolError(f"No note matches '{ref}'.")
    if len(rows) > 1:
        titles = "; ".join(f"{r['id']}: {r['title']}" for r in rows)
        raise ToolError(f"More than one note matches '{ref}': {titles}. Ask which one, by number.")
    return rows[0]


def create_note(args: dict) -> str:
    title, body = args["title"].strip(), args["body"].strip()
    if not title or not body:
        raise ToolError("A note needs both a title and some text.")
    if len(title) > MAX_TITLE or len(body) > MAX_BODY:
        raise ToolError("That note is too long.")
    with connect() as db:
        cur = db.execute(
            "INSERT INTO notes (title, body, created_at) VALUES (?, ?, ?)",
            (title, body, datetime.now(UTC).isoformat(timespec="seconds")),
        )
    return f"Saved note {cur.lastrowid}: {title}."


def list_notes(args: dict) -> str:
    limit = int(args.get("limit", 5))
    with connect() as db:
        rows = db.execute("SELECT id, title FROM notes ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        total = db.execute("SELECT count(*) FROM notes").fetchone()[0]
    if not rows:
        return "There are no notes yet."
    listed = "; ".join(f"{r['id']}: {r['title']}" for r in rows)
    return f"{total} notes in all. Latest: {listed}."


def search_notes(args: dict) -> str:
    q = args["query"].strip()
    if not q:
        raise ToolError("Say what to search for.")
    with connect() as db:
        rows = db.execute(
            "SELECT id, title, body FROM notes WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'"
            " ORDER BY id DESC LIMIT 5",
            (_like(q), _like(q)),
        ).fetchall()
    if not rows:
        return f"No notes mention '{q}'."
    return "\n".join(f"{r['id']}: {r['title']} - {r['body'][:140]}" for r in rows)


def read_note(args: dict) -> str:
    with connect() as db:
        row = resolve(db, args["note"])
    return f"{row['title']}: {row['body']}"


def delete_note(args: dict) -> str:
    with connect() as db:
        row = resolve(db, args["note"])
        db.execute("DELETE FROM notes WHERE id = ?", (row["id"],))
    return f"Deleted the note '{row['title']}'."


def build() -> McpServer:
    scopes = frozenset(
        s.strip() for s in os.environ.get("MCP_GRANTED_SCOPES", "notes:read").split(",") if s.strip()
    )
    note_ref = {
        "type": "string",
        "description": "The note's number, or all or part of its title.",
        "maxLength": 200,
    }
    tools = [
        Tool(
            "create_note",
            "Save a new note for the user.",
            {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "A short title.", "maxLength": MAX_TITLE},
                    "body": {"type": "string", "description": "The note's text.", "maxLength": MAX_BODY},
                },
                "required": ["title", "body"],
            },
            "notes:write",
            create_note,
        ),
        Tool(
            "list_notes",
            "List the user's most recent notes.",
            {
                "type": "object",
                "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 20}},
            },
            "notes:read",
            list_notes,
            read_only=True,
        ),
        Tool(
            "search_notes",
            "Find notes whose title or text mentions a word or phrase.",
            {
                "type": "object",
                "properties": {"query": {"type": "string", "maxLength": 200}},
                "required": ["query"],
            },
            "notes:read",
            search_notes,
            read_only=True,
        ),
        Tool(
            "read_note",
            "Read one note in full.",
            {"type": "object", "properties": {"note": note_ref}, "required": ["note"]},
            "notes:read",
            read_note,
            read_only=True,
        ),
        Tool(
            "delete_note",
            "Permanently delete one note.",
            {"type": "object", "properties": {"note": note_ref}, "required": ["note"]},
            "notes:delete",
            delete_note,
            destructive=True,
            confirm_prompt='delete the note "{note}"',
        ),
    ]
    return McpServer("notes", "0.1.0", tools, scopes)


if __name__ == "__main__":
    print("[notes] ready", file=sys.stderr)
    build().serve()
