"""A stand-in for Notion: its OAuth screens and the few API calls the brain makes.

Used by the tests (through an in-process transport) and by
`scripts/fake_notion.py` so the whole connect flow can be tried locally before a
real Notion integration exists. It approves every authorisation instantly.
"""

from __future__ import annotations

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import RedirectResponse

TOKEN = "secret_fake_notion_token"


def build() -> FastAPI:
    app = FastAPI()
    pages: dict[str, dict] = {
        "page-1": {"title": "Ideas", "text": ["Build a voice assistant", "Add calendar later"]},
    }
    app.state.pages = pages
    app.state.codes = {"fakecode": "ok"}

    def auth(authorization: str | None) -> None:
        if authorization != f"Bearer {TOKEN}":
            raise HTTPException(status_code=401, detail="bad token")

    @app.get("/v1/oauth/authorize")
    async def authorize(redirect_uri: str, state: str, client_id: str = "", response_type: str = "", owner: str = ""):
        return RedirectResponse(f"{redirect_uri}?code=fakecode&state={state}")

    @app.post("/v1/oauth/token")
    async def token(request: Request):
        body = await request.json()
        if body.get("code") not in app.state.codes:
            raise HTTPException(status_code=400, detail="bad code")
        return {"access_token": TOKEN, "workspace_name": "Fake Workspace", "bot_id": "bot", "workspace_id": "w"}

    def page_json(pid: str) -> dict:
        p = pages[pid]
        return {
            "object": "page",
            "id": pid,
            "properties": {"title": {"type": "title", "title": [{"plain_text": p["title"]}]}},
        }

    @app.post("/v1/search")
    async def search(request: Request, authorization: str | None = Header(default=None)):
        auth(authorization)
        body = await request.json()
        q = (body.get("query") or "").lower()
        hits = [page_json(i) for i, p in pages.items() if q in p["title"].lower()]
        return {"results": hits[: body.get("page_size", 10)]}

    @app.get("/v1/pages/{pid}")
    async def get_page(pid: str, authorization: str | None = Header(default=None)):
        auth(authorization)
        if pid not in pages:
            raise HTTPException(status_code=404, detail="no such page")
        return page_json(pid)

    @app.get("/v1/blocks/{pid}/children")
    async def children(pid: str, authorization: str | None = Header(default=None)):
        auth(authorization)
        return {
            "results": [
                {"type": "paragraph", "paragraph": {"rich_text": [{"plain_text": t}]}} for t in pages[pid]["text"]
            ]
        }

    @app.post("/v1/pages")
    async def create(request: Request, authorization: str | None = Header(default=None)):
        auth(authorization)
        body = await request.json()
        pid = f"page-{len(pages) + 1}"
        title = body["properties"]["title"]["title"][0]["text"]["content"]
        text = [b["paragraph"]["rich_text"][0]["text"]["content"] for b in body.get("children", [])]
        pages[pid] = {"title": title, "text": text, "parent": body["parent"]["page_id"]}
        return {"id": pid}

    return app
