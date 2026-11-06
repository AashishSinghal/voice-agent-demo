"""A conversation thread: what it holds, and the rules for changing it.

The graph checkpoints its own history, so everything about a thread that is not
"run a turn" lives here: reading it back, rewriting the last reply to what the
caller actually heard, and spotting a question waiting for a spoken yes. Routes
translate HTTP; they do not poke at checkpoints.
"""

from __future__ import annotations

import asyncio
import weakref

from langchain_core.messages import AIMessage, RemoveMessage

from .contract import HeardRequest


def config_for(session_id: str) -> dict:
    return {"configurable": {"thread_id": session_id}}


async def pending_approvals(graph, config) -> list[dict]:
    """Questions the thread is paused on, waiting for the caller's answer."""
    state = await graph.aget_state(config)
    return [i.value for task in state.tasks for i in task.interrupts]


class Threads:
    def __init__(self, graph) -> None:
        self.graph = graph
        # One report at a time per thread: a timed-out attempt may still be
        # running when its retry arrives.
        self._locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()

    async def history(self, session_id: str) -> dict:
        config = config_for(session_id)
        values = (await self.graph.aget_state(config)).values or {}
        pending = await pending_approvals(self.graph, config)
        messages = values.get("messages", [])
        return {
            "sessionId": session_id,
            "messages": len(messages),
            "sessionUsd": values.get("session_usd", 0.0),
            "pendingApproval": pending[0] if pending else None,
            "history": [
                {
                    "role": m.type,
                    "content": m.content if isinstance(m.content, str) else str(m.content),
                    "interrupted": bool(m.additional_kwargs.get("interrupted")),
                    "unspoken": m.additional_kwargs.get("unspoken"),
                }
                for m in messages
            ],
        }

    async def apply_heard(self, session_id: str, report: HeardRequest) -> dict:
        """Rewrite the last reply to what the caller actually heard.

        Without this the brain would keep the full generated text and later
        refer to sentences nobody heard.
        """
        lock = self._locks.get(session_id) or self._locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            return await self._apply_heard(session_id, report)

    async def _apply_heard(self, session_id: str, report: HeardRequest) -> dict:
        config = config_for(session_id)
        values = (await self.graph.aget_state(config)).values or {}
        messages = values.get("messages", [])
        # Removing a reply is not repeatable (a second run would remove the
        # previous turn's), so a report already applied must be a no-op.
        if report.report_id and report.report_id in values.get("heard_ids", []):
            return {"updated": False, "duplicate": True}
        if not messages or await pending_approvals(self.graph, config):
            # Nothing to rewrite, or the thread is paused on a question: adding
            # a message now would corrupt the call the approval will resume.
            return {"updated": False}

        spoken = report.spoken.strip()
        last = messages[-1]
        extra = {"interrupted": True, "unspoken": report.unspoken or None}
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
        marker = {"heard_ids": [report.report_id]} if report.report_id else {}
        await self.graph.aupdate_state(config, {"messages": [update], **marker}, as_node="call_model")
        return {"updated": True}
