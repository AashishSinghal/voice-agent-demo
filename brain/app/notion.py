"""Notion as tools, for one user's token.

Called straight over Notion's REST API rather than through an MCP server: the
token differs for every user and the brain can run where subprocesses cannot, so
a per-user server process is the wrong shape. Three tools: look things up, read a
page, add a note. Only the last changes anything, so only it asks first.
"""

from __future__ import annotations

from typing import Any

import httpx
from langchain_core.tools import StructuredTool

from .tools import ToolEntry

NOTION_VERSION = "2022-06-28"
MAX_BLOCKS = 100
MAX_READ_CHARS = 4000


def _title(obj: dict[str, Any]) -> str:
    if obj.get("object") == "database":
        return "".join(t.get("plain_text", "") for t in obj.get("title", [])) or "Untitled"
    for prop in obj.get("properties", {}).values():
        if prop.get("type") == "title":
            return "".join(t.get("plain_text", "") for t in prop.get("title", [])) or "Untitled"
    return "Untitled"


def _block_text(block: dict[str, Any]) -> str:
    body = block.get(block.get("type", ""), {})
    return "".join(t.get("plain_text", "") for t in body.get("rich_text", []))


def notion_entries(
    token: str, api_base: str, transport: httpx.AsyncBaseTransport | None = None
) -> list[ToolEntry]:
    headers = {"Authorization": f"Bearer {token}", "Notion-Version": NOTION_VERSION}

    async def call(method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        async with httpx.AsyncClient(
            base_url=api_base, headers=headers, timeout=15, transport=transport
        ) as client:
            r = await client.request(method, path, **kwargs)
        if r.status_code == 401:
            raise RuntimeError("Notion no longer accepts this connection; the user should connect it again.")
        if r.status_code >= 400:
            detail = r.json().get("message", "error")
            raise RuntimeError(f"Notion returned {r.status_code}: {detail}")
        return r.json()

    async def search(query: str) -> str:
        """Search the user's Notion pages by title. Returns each match's title and id."""
        data = await call("POST", "/v1/search", json={"query": query, "page_size": 8})
        rows = [f"{_title(r)} (id {r['id']}, {r['object']})" for r in data.get("results", [])]
        return "\n".join(rows) or (
            "Nothing in the user's Notion matched. Pages only appear if they were shared with the assistant."
        )

    async def read_page(page_id: str) -> str:
        """Read a Notion page's title and text, given its id from a search."""
        page = await call("GET", f"/v1/pages/{page_id}")
        blocks = await call("GET", f"/v1/blocks/{page_id}/children", params={"page_size": MAX_BLOCKS})
        lines = [t for b in blocks.get("results", []) if (t := _block_text(b))]
        text = "\n".join(lines)
        if len(text) > MAX_READ_CHARS:
            text = text[:MAX_READ_CHARS] + "\n[cut off]"
        return f"{_title(page)}\n{text}" if text else f"{_title(page)}\n(empty page)"

    async def add_note(title: str, text: str, parent_page_id: str = "") -> str:
        """Add a note to the user's Notion as a new page with a title and text.

        Leave parent_page_id empty to file it under the first page the user shared.
        """
        parent = parent_page_id
        if not parent:
            found = await call(
                "POST", "/v1/search", json={"filter": {"property": "object", "value": "page"}, "page_size": 1}
            )
            if not found.get("results"):
                return (
                    "There is no shared page to file this under. "
                    "The user needs to share a page with the assistant in Notion."
                )
            parent = found["results"][0]["id"]
        created = await call(
            "POST",
            "/v1/pages",
            json={
                "parent": {"page_id": parent},
                "properties": {"title": {"title": [{"text": {"content": title[:200]}}]}},
                "children": [
                    {
                        "object": "block",
                        "type": "paragraph",
                        "paragraph": {"rich_text": [{"type": "text", "text": {"content": text[:1900]}}]},
                    }
                ],
            },
        )
        return f'Added the note "{title}" (id {created["id"]}).'

    def make(fn, name: str, risk: str, prompt: str | None = None) -> ToolEntry:
        tool = StructuredTool.from_function(coroutine=fn, name=name, description=fn.__doc__ or name)
        return ToolEntry(tool, risk, connector="notion", confirm_prompt=prompt)  # type: ignore[arg-type]

    return [
        make(search, "notion_search", "safe"),
        make(read_page, "notion_read_page", "safe"),
        make(add_note, "notion_add_note", "confirm", 'add a note called "{title}" to your Notion'),
    ]


class NotionTools:
    """Hands out Notion tools to owners who have connected it."""

    def __init__(self, connections, api_base: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._connections = connections
        self._api_base = api_base
        self._transport = transport

    async def __call__(self, owner: str) -> list[ToolEntry]:
        secret = await self._connections.secret(owner, "notion")
        if not secret:
            return []
        return notion_entries(secret["access_token"], self._api_base, self._transport)
