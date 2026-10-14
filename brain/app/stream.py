"""Turn a graph run into contract events."""

from __future__ import annotations

from collections.abc import AsyncIterator

from langchain_core.messages import AIMessageChunk, HumanMessage, ToolMessage

from .contract import (
    Context,
    Done,
    Error,
    Event,
    Token,
    ToolCall,
    ToolResult,
    TurnRequest,
    Usage,
)


async def run_turn(graph, req: TurnRequest) -> AsyncIterator[Event]:
    config = {"configurable": {"thread_id": req.session_id}}
    # Per-turn counters reset here; the session total persists in state.
    turn_input = {
        "messages": [HumanMessage(content=req.text)],
        "steps": 0,
        "turn_usd": 0.0,
        "degraded": False,
    }
    final_text = ""
    try:
        async for mode, data in graph.astream(
            turn_input, config, stream_mode=["messages", "custom", "updates"]
        ):
            if mode == "messages":
                chunk, meta = data
                if (
                    meta.get("langgraph_node") == "call_model"
                    and isinstance(chunk, AIMessageChunk)
                    and isinstance(chunk.content, str)
                    and chunk.content
                ):
                    yield Token(text=chunk.content)
            elif mode == "custom":
                kind = data.get("type")
                if kind == "context":
                    yield Context(report=data["report"])
                elif kind == "usage":
                    yield Usage(**{k: v for k, v in data.items() if k != "type"})
                elif kind == "token":
                    yield Token(text=data["text"])
            elif mode == "updates":
                for node, update in data.items():
                    if not isinstance(update, dict):
                        continue
                    for msg in update.get("messages", []):
                        if node == "call_model":
                            for call in msg.tool_calls:
                                yield ToolCall(id=call["id"], name=call["name"], args=call["args"])
                            if not msg.tool_calls and isinstance(msg.content, str):
                                final_text = msg.content
                        elif node == "tools" and isinstance(msg, ToolMessage):
                            yield ToolResult(
                                id=msg.tool_call_id, name=msg.name or "", content=str(msg.content)
                            )

        state = await graph.aget_state(config)
        values = state.values
        yield Done(
            text=final_text,
            turn_usd=values.get("turn_usd", 0.0),
            steps=values.get("steps", 0),
            degraded=values.get("degraded", False),
        )
    except Exception as exc:  # the gateway must always get a terminal event
        yield Error(message=f"{type(exc).__name__}: {exc}")
