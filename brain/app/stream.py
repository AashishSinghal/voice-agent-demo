"""Turn a graph run into contract events, and answer pending approvals."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator

from langchain_core.messages import AIMessageChunk, HumanMessage, ToolMessage
from langgraph.types import Command

from .approval import classify
from .contract import (
    ApprovalRequired,
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

MAX_PENDING = 10  # a model cannot talk the loop into asking forever


async def pending_approvals(graph, config) -> list[dict]:
    state = await graph.aget_state(config)
    return [i.value for task in state.tasks for i in task.interrupts]


async def run_turn(graph, req: TurnRequest, approval_ttl_s: int = 600) -> AsyncIterator[Event]:
    config = {"configurable": {"thread_id": req.session_id}}
    try:
        pending = await pending_approvals(graph, config)
    except Exception as exc:
        yield Error(message=f"{type(exc).__name__}: {exc}")
        return

    if pending:
        verdict = classify(req.text)
        expired = time.time() - pending[0].get("requested_at", 0) > approval_ttl_s
        if verdict in ("yes", "no") and not expired:
            # Only an unambiguous yes approves. Each risky call is asked about
            # in turn, so a yes covers exactly the action that was described.
            last: list[Event] = []
            for _ in range(MAX_PENDING):
                last = [
                    e
                    async for e in _drive(
                        graph,
                        Command(resume={"approved": verdict == "yes", "silent": False}),
                        config,
                    )
                ]
                # "no" declines everything pending; "yes" approves just this one.
                if verdict == "yes" or not await pending_approvals(graph, config):
                    break
            for event in last:
                yield event
            return

        # Anything else (a new request, or an approval that has gone stale)
        # declines what was pending, silently, and is handled as a fresh turn.
        for _ in range(MAX_PENDING):
            if not await pending_approvals(graph, config):
                break
            async for _event in _drive(graph, Command(resume={"approved": False, "silent": True}), config):
                pass

    # Per-turn counters reset here; the session total persists in state.
    turn_input = {
        "messages": [HumanMessage(content=req.text)],
        "steps": 0,
        "turn_usd": 0.0,
        "degraded": False,
    }
    async for event in _drive(graph, turn_input, config):
        yield event


async def _drive(graph, graph_input, config) -> AsyncIterator[Event]:
    final_text = ""
    awaiting = False
    try:
        # Write the checkpoint once, when the run ends, instead of after every
        # step. Against hosted Postgres each write is a network round trip: warm
        # turns measured about 3.2 s with per-step writes and 1.1 s with one, at
        # 240 ms per round trip. The checkpoint is still written if the run is
        # cancelled or pauses on a question, which an interruption and an
        # approval need; a crash mid-turn loses only that turn.
        async for mode, data in graph.astream(
            graph_input,
            config,
            stream_mode=["messages", "custom", "updates"],
            durability="exit",
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
                    final_text += data["text"]
                    yield Token(text=data["text"])
            elif mode == "updates":
                for node, update in data.items():
                    if node == "__interrupt__":
                        for item in update:
                            ask = item.value
                            awaiting = True
                            final_text = ask["prompt"]
                            # Spoken like any other reply: the gateway needs no
                            # special case to read the question aloud.
                            yield Token(text=ask["prompt"])
                            yield ApprovalRequired(
                                call_id=ask["call_id"],
                                tool=ask["tool"],
                                args=ask["args"],
                                prompt=ask["prompt"],
                            )
                        continue
                    if not isinstance(update, dict):
                        continue
                    for msg in update.get("messages", []):
                        if node == "call_model":
                            for call in msg.tool_calls:
                                yield ToolCall(id=call["id"], name=call["name"], args=call["args"])
                            if not msg.tool_calls and isinstance(msg.content, str):
                                final_text = msg.content
                        elif node == "execute" and isinstance(msg, ToolMessage):
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
            awaiting_approval=awaiting,
        )
    except Exception as exc:  # the gateway must always get a terminal event
        yield Error(message=f"{type(exc).__name__}: {exc}")
