from __future__ import annotations

import asyncio
import hmac
import logging
import weakref
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from langchain_core.language_models.chat_models import BaseChatModel
from sse_starlette.sse import EventSourceResponse

from .connectors import connect_all, environment, load_specs
from .contract import HeardRequest, TurnRequest
from .graph import build_graph
from .settings import Settings
from .store import open_checkpointer
from .stream import run_turn
from .thread import Threads
from .tools import ToolSet


def create_app(
    settings: Settings | None = None,
    fake_model: BaseChatModel | None = None,
    toolset: ToolSet | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()

    @dataclass
    class Runtime:
        graph: object
        toolset: ToolSet
        connectors: list
        stack: AsyncExitStack
        threads: Threads
        loop: asyncio.AbstractEventLoop  # database pools and subprocess pipes belong to it

    state: dict[str, Runtime | None] = {"runtime": None}
    locks: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()

    async def get_runtime() -> Runtime:
        """Build the graph, database connection and connectors on first use.

        Not tied to FastAPI's lifespan: a serverless host may never run it, and
        the first request has to work regardless. Locally the lifespan below
        calls this at startup so problems show up at once.
        """
        loop = asyncio.get_running_loop()
        lock = locks.setdefault(loop, asyncio.Lock())
        async with lock:
            current = state["runtime"]
            if current is not None and current.loop is not loop:
                # Built on another event loop, which a host that gives every
                # invocation its own loop has since closed. Its connections went
                # with it, so start over rather than fail on a dead connection.
                logging.getLogger("brain").info("event loop changed, rebuilding the runtime")
                try:
                    await current.stack.aclose()
                except Exception:  # best effort: the old loop may already be gone
                    pass
                state["runtime"] = None
            if state["runtime"] is None:
                stack = AsyncExitStack()
                try:
                    tools = toolset or ToolSet()
                    specs, failed = load_specs(
                        Path(settings.connectors_config) if settings.connectors_config else None,
                        environment(),
                    )
                    connectors = [*failed, *await connect_all(specs, tools)]
                    stack.push_async_callback(tools.close)
                    saver = await stack.enter_async_context(open_checkpointer(settings))
                    graph = build_graph(settings, saver, fake_model, tools)
                except BaseException:
                    await stack.aclose()
                    raise
                state["runtime"] = Runtime(graph, tools, connectors, stack, Threads(graph), loop)
            return state["runtime"]

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await get_runtime()
        try:
            yield
        finally:
            if state["runtime"] is not None:
                await state["runtime"].stack.aclose()
                state["runtime"] = None

    async def require_key(authorization: str | None = Header(default=None)) -> None:
        """Shared-secret check for everything under /v1.

        The brain is a public URL when hosted, and it can run tools on someone's
        accounts, so it never answers an unauthenticated caller. Compared in
        constant time so the key cannot be guessed from response timing.
        """
        if not settings.api_key:
            return
        expected = f"Bearer {settings.api_key}".encode()
        if not authorization or not hmac.compare_digest(authorization.encode(), expected):
            raise HTTPException(status_code=401, detail="missing or invalid API key")

    app = FastAPI(title="voice-agent-brain", lifespan=lifespan)
    app.state.get_runtime = get_runtime  # for tests and tooling that need the graph
    secured = {"dependencies": [Depends(require_key)]}

    @app.get("/health")
    async def health(authorization: str | None = Header(default=None)):
        # Open so a platform or the gateway can warm and probe it, but with a key
        # configured an anonymous caller learns only that it is up.
        if settings.api_key:
            try:
                await require_key(authorization)
            except HTTPException:
                return {"status": "ok"}
        rt = await get_runtime()
        return {
            "status": "ok",
            "provider": settings.provider,
            "tiers": [t.name for t in settings.tiers],
            "turnBudgetUsd": settings.turn_budget_usd,
            "storage": "postgres" if settings.database_url else "sqlite",
            "connectors": [c.to_dict() for c in rt.connectors],
        }

    @app.get("/v1/tools", **secured)
    async def tools_list():
        rt = await get_runtime()
        return [{"name": e.name, "risk": e.risk, "connector": e.connector} for e in rt.toolset.entries]

    @app.post("/v1/turn", **secured)
    async def turn(req: TurnRequest):
        rt = await get_runtime()

        async def events():
            async for event in run_turn(rt.graph, req, settings.approval_ttl_s):
                yield {"event": event.type, "data": event.model_dump_json()}

        return EventSourceResponse(events())

    @app.get("/v1/threads/{session_id}", **secured)
    async def thread(session_id: str):
        return await (await get_runtime()).threads.history(session_id)

    @app.post("/v1/threads/{session_id}/heard", **secured)
    async def heard(session_id: str, req: HeardRequest):
        return await (await get_runtime()).threads.apply_heard(session_id, req)

    return app
