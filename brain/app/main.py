from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, RemoveMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from sse_starlette.sse import EventSourceResponse

from .contract import HeardRequest, TurnRequest
from .graph import build_graph
from .settings import Settings
from .stream import run_turn


def create_app(settings: Settings | None = None, fake_model: BaseChatModel | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.db_path != ":memory:":
            Path(settings.db_path).parent.mkdir(parents=True, exist_ok=True)
        async with AsyncSqliteSaver.from_conn_string(settings.db_path) as saver:
            app.state.graph = build_graph(settings, saver, fake_model)
            yield

    app = FastAPI(title="voice-agent-brain", lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "provider": settings.provider,
            "tiers": [t.name for t in settings.tiers],
            "turnBudgetUsd": settings.turn_budget_usd,
        }

    @app.post("/v1/turn")
    async def turn(req: TurnRequest):
        async def events():
            async for event in run_turn(app.state.graph, req):
                yield {"event": event.type, "data": event.model_dump_json()}

        return EventSourceResponse(events())

    @app.get("/v1/threads/{session_id}")
    async def thread(session_id: str):
        state = await app.state.graph.aget_state({"configurable": {"thread_id": session_id}})
        values = state.values or {}
        return {
            "sessionId": session_id,
            "messages": len(values.get("messages", [])),
            "sessionUsd": values.get("session_usd", 0.0),
        }

    @app.post("/v1/threads/{session_id}/heard")
    async def heard(session_id: str, req: HeardRequest):
        """Rewrite the last reply to what the caller actually heard.

        The brain checkpoints its own history, so without this it would keep
        the full generated text and later refer to sentences nobody heard.
        """
        config = {"configurable": {"thread_id": session_id}}
        state = await app.state.graph.aget_state(config)
        messages = (state.values or {}).get("messages", [])
        if not messages:
            return {"updated": False}

        spoken = req.spoken.strip()
        last = messages[-1]
        extra = {"interrupted": True, "unspoken": req.unspoken or None}
        # A reply cut off before the graph finished never reached the
        # checkpoint: the thread then ends on the caller's message, and the
        # heard text must be appended. Rewriting "the last assistant message"
        # blindly would overwrite the previous turn's answer.
        if isinstance(last, AIMessage) and not last.tool_calls:
            update = (
                AIMessage(content=spoken, id=last.id, additional_kwargs=extra)
                if spoken
                else RemoveMessage(id=last.id)
            )
        elif spoken:
            update = AIMessage(content=spoken, additional_kwargs=extra)
        else:
            return {"updated": False}
        await app.state.graph.aupdate_state(config, {"messages": [update]}, as_node="call_model")
        return {"updated": True}

    return app
