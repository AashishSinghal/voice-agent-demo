"""The agent graph.

    START -> call_model -+-> END                 (no tool requested)
                  ^      |
                  |      v
                  +---- tools                   (run, loop back)

`call_model` is where the foundation layers meet: it assembles a budgeted
context, asks the cost guard which tier may be called, calls it, and records
what it cost. Keeping them in one node means every model call, whichever path
reached it, goes through the same two gates.

State is checkpointed per thread, so a conversation survives a restart.
"""

from __future__ import annotations

from typing import Annotated, TypedDict

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AnyMessage
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.config import get_stream_writer
from langgraph.graph import START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition

from .context import assemble
from .cost import CostGuard
from .llm import build_model
from .settings import Settings
from .tokens import count_text
from .tools import all_tools

SYSTEM_PROMPT = (
    "You are a helpful voice assistant in a spoken conversation. Keep answers "
    "short, speak naturally, and use no lists, markdown or emoji. Use a tool "
    "when it gives a more reliable answer than guessing."
)

HALT_TEXT = "I got stuck going in circles on that, so I stopped. Could you ask it a different way?"
OVER_BUDGET_TEXT = "I've used up what I'm allowed to spend on that request, so I can't answer it right now."


class State(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    steps: int
    turn_usd: float
    session_usd: float
    degraded: bool


def build_graph(
    settings: Settings,
    checkpointer: BaseCheckpointSaver | None = None,
    fake_model: BaseChatModel | None = None,
):
    guard = CostGuard(tiers=settings.tiers, cap_usd=settings.turn_budget_usd, max_steps=settings.max_steps)
    tools = all_tools()
    schemas = [convert_to_openai_tool(t) for t in tools]

    async def call_model(state: State) -> dict:
        write = get_stream_writer()
        steps = state.get("steps", 0)
        turn_usd = state.get("turn_usd", 0.0)

        ctx = assemble(
            system=SYSTEM_PROMPT,
            history=state["messages"],
            tools=schemas,
            window=settings.context_window,
            reserve_output=settings.reserve_output,
        )
        write({"type": "context", "report": ctx.report.to_dict()})

        decision = guard.select(
            prompt_tokens=ctx.report.total_used,
            max_output_tokens=settings.reserve_output,
            steps=steps,
            spent_usd=turn_usd,
        )

        if decision.action != "call" or decision.tier is None:
            text = HALT_TEXT if decision.action == "halt" else OVER_BUDGET_TEXT
            write({"type": "token", "text": text})
            return {
                "messages": [AIMessage(content=text)],
                "steps": steps + 1,
                "degraded": True,
            }

        kept = {s["function"]["name"] for s in ctx.tools}
        model = build_model(decision.tier, fake_model).bind_tools([t for t in tools if t.name in kept])
        response = await model.ainvoke(ctx.messages)

        usage = getattr(response, "usage_metadata", None) or {}
        prompt_tokens = usage.get("input_tokens") or ctx.report.total_used
        completion_tokens = usage.get("output_tokens") or count_text(str(response.content))
        usd = decision.tier.cost(prompt_tokens, completion_tokens)

        write(
            {
                "type": "usage",
                "tier": decision.tier.name,
                "model": decision.tier.model,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "usd": usd,
                "turn_usd": turn_usd + usd,
                "degraded_from": decision.degraded_from,
            }
        )
        return {
            "messages": [response],
            "steps": steps + 1,
            "turn_usd": turn_usd + usd,
            "session_usd": state.get("session_usd", 0.0) + usd,
            "degraded": bool(decision.degraded_from) or state.get("degraded", False),
        }

    graph = StateGraph(State)
    graph.add_node("call_model", call_model)
    graph.add_node("tools", ToolNode(tools))
    graph.add_edge(START, "call_model")
    graph.add_conditional_edges("call_model", tools_condition)
    graph.add_edge("tools", "call_model")
    return graph.compile(checkpointer=checkpointer)
