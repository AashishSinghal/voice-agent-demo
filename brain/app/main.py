from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, RemoveMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from sse_starlette.sse import EventSourceResponse

from .connectors import connect_all, environment, load_specs
from .contract import HeardRequest, TurnRequest
from .graph import build_graph
from .settings import Settings
from .stream import pending_approvals, run_turn
from .tools import ToolSet


def create_app(
    settings: Settings | None = None,
    fake_model: BaseChatModel | None = None,
    toolset: ToolSet | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.db_path != ":memory:":
            Path(settings.db_path).parent.mkdir(parents=True, exist_ok=True)
        tools = toolset or ToolSet()
        specs, failed = load_specs(
            Path(settings.connectors_config) if settings.connectors_config else None, environment()
        )
        app.state.connectors = [*failed, *await connect_all(specs, tools)]
        app.state.toolset = tools
        try:
            async with AsyncSqliteSaver.from_conn_string(settings.db_path) as saver:
                app.state.graph = build_graph(settings, saver, fake_model, tools)
                yield
        finally:
            await tools.close()

    app = FastAPI(title="voice-agent-brain", lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "provider": settings.provider,
            "tiers": [t.name for t in settings.tiers],
            "turnBudgetUsd": settings.turn_budget_usd,
            "connectors": [c.to_dict() for c in app.state.connectors],
        }

    @app.get("/v1/tools")
    async def tools_list():
        return [{"name": e.name, "risk": e.risk, "connector": e.connector} for e in app.state.toolset.entries]

    @app.post("/v1/turn")
    async def turn(req: TurnRequest):
        async def events():
            async for event in run_turn(app.state.graph, req, settings.approval_ttl_s):
                yield {"event": event.type, "data": event.model_dump_json()}

        return EventSourceResponse(events())

    @app.get("/v1/threads/{session_id}")
    async def thread(session_id: str):
        state = await app.state.graph.aget_state({"configurable": {"thread_id": session_id}})
        values = state.values or {}
        pending = await pending_approvals(app.state.graph, {"configurable": {"thread_id": session_id}})
        return {
            "sessionId": session_id,
            "messages": len(values.get("messages", [])),
            "sessionUsd": values.get("session_usd", 0.0),
            "pendingApproval": pending[0] if pending else None,
            "history": [
                {
                    "role": m.type,
                    "content": m.content if isinstance(m.content, str) else str(m.content),
                    "interrupted": bool(m.additional_kwargs.get("interrupted")),
                    "unspoken": m.additional_kwargs.get("unspoken"),
                }
                for m in values.get("messages", [])
            ],
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
        if not messages or await pending_approvals(app.state.graph, config):
            # Nothing to rewrite, or the thread is paused on a question: adding
            # a message now would corrupt the call the approval will resume.
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
