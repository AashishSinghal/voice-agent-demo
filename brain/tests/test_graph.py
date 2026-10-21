import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from app.contract import Done, Error, Token, ToolCall, ToolResult, TurnRequest, Usage
from app.cost import tier_for
from app.graph import HALT_TEXT, build_graph
from app.llm import ScriptedChatModel
from app.settings import Settings
from app.stream import run_turn


def settings(**kw):
    base = dict(tiers=[tier_for("local", "fake", "fake")], max_steps=6)
    base.update(kw)
    return Settings(**base)


async def collect(graph, text="hi", session="s1"):
    return [e async for e in run_turn(graph, TurnRequest(session_id=session, text=text))]


async def test_plain_answer_streams_tokens_then_done():
    model = ScriptedChatModel(script=[AIMessage(content="Hello there friend")])
    events = await collect(build_graph(settings(), MemorySaver(), model))
    kinds = [e.type for e in events]
    assert kinds[0] == "context" and kinds[-1] == "done"
    assert "".join(e.text for e in events if isinstance(e, Token)) == "Hello there friend"
    assert next(e for e in events if isinstance(e, Done)).text == "Hello there friend"


async def test_tool_loop_runs_tool_and_answers():
    model = ScriptedChatModel(
        script=[
            AIMessage(content="", tool_calls=[{"name": "add_numbers", "args": {"a": 2, "b": 3}, "id": "c1"}]),
            AIMessage(content="That makes five."),
        ]
    )
    events = await collect(build_graph(settings(), MemorySaver(), model), "add 2 and 3")
    call = next(e for e in events if isinstance(e, ToolCall))
    result = next(e for e in events if isinstance(e, ToolResult))
    assert call.name == "add_numbers" and call.args == {"a": 2, "b": 3}
    assert result.content == "5.0"
    done = next(e for e in events if isinstance(e, Done))
    assert done.text == "That makes five." and done.steps == 2


async def test_runaway_loop_is_halted_by_step_limit():
    loop_call = AIMessage(content="", tool_calls=[{"name": "get_current_time", "args": {}, "id": "c"}])
    model = ScriptedChatModel(script=[loop_call], loop=True)
    events = await collect(build_graph(settings(max_steps=3), MemorySaver(), model))
    done = next(e for e in events if isinstance(e, Done))
    assert done.degraded and done.text == HALT_TEXT
    assert sum(isinstance(e, ToolCall) for e in events) == 3


async def test_over_budget_degrades_to_cache_message():
    model = ScriptedChatModel(script=[AIMessage(content="never reached")])
    # Single paid tier, zero budget: nothing fits, no free tier to fall back on.
    paid = tier_for("frontier", "fake", "openai/gpt-oss-120b")
    s = settings(tiers=[paid], turn_budget_usd=0.0)
    events = await collect(build_graph(s, MemorySaver(), model))
    done = next(e for e in events if isinstance(e, Done))
    assert done.degraded and "allowed to spend" in done.text


async def test_usage_event_reports_tier_and_cost():
    paid = tier_for("mid", "fake", "openai/gpt-oss-20b")
    model = ScriptedChatModel(script=[AIMessage(content="Fine.")])
    events = await collect(build_graph(settings(tiers=[paid]), MemorySaver(), model))
    usage = next(e for e in events if isinstance(e, Usage))
    assert usage.tier == "mid" and usage.usd > 0 and usage.prompt_tokens > 0


class Boom(ScriptedChatModel):
    def _generate(self, *a, **k):
        raise RuntimeError("provider down")

    def _stream(self, *a, **k):
        raise RuntimeError("provider down")


async def test_a_provider_failure_degrades_instead_of_ending_the_turn():
    """With nothing else to fall back to, the caller still gets a spoken answer."""
    from app.graph import UNAVAILABLE_TEXT

    events = await collect(build_graph(settings(), MemorySaver(), Boom(script=[])))
    done = next(e for e in events if isinstance(e, Done))
    assert done.degraded and done.text == UNAVAILABLE_TEXT
    assert not any(isinstance(e, Error) for e in events)


async def test_a_failing_tier_steps_down_to_the_next_one():
    frontier = tier_for("frontier", "fake", "openai/gpt-oss-120b")
    mid = tier_for("mid", "fake", "openai/gpt-oss-20b")
    models = {"frontier": Boom(script=[]), "mid": ScriptedChatModel(script=[AIMessage(content="From mid.")])}
    s = settings(tiers=[frontier, mid])
    events = await collect(build_graph(s, MemorySaver(), models))

    done = next(e for e in events if isinstance(e, Done))
    assert done.text == "From mid." and done.degraded
    usage = next(e for e in events if isinstance(e, Usage))
    assert usage.tier == "mid" and usage.degraded_from == "frontier"


async def test_a_healthy_preferred_tier_is_not_reported_as_degraded():
    frontier = tier_for("frontier", "fake", "openai/gpt-oss-120b")
    mid = tier_for("mid", "fake", "openai/gpt-oss-20b")
    models = {
        "frontier": ScriptedChatModel(script=[AIMessage(content="From frontier.")]),
        "mid": Boom(script=[]),
    }
    events = await collect(build_graph(settings(tiers=[frontier, mid]), MemorySaver(), models))
    done = next(e for e in events if isinstance(e, Done))
    assert done.text == "From frontier." and not done.degraded


async def test_every_tier_failing_is_not_blamed_on_the_budget():
    from app.graph import OVER_BUDGET_TEXT, UNAVAILABLE_TEXT

    frontier = tier_for("frontier", "fake", "openai/gpt-oss-120b")
    mid = tier_for("mid", "fake", "openai/gpt-oss-20b")
    models = {"frontier": Boom(script=[]), "mid": Boom(script=[])}
    events = await collect(build_graph(settings(tiers=[frontier, mid]), MemorySaver(), models))
    done = next(e for e in events if isinstance(e, Done))
    assert done.text == UNAVAILABLE_TEXT and done.text != OVER_BUDGET_TEXT


async def test_thread_survives_a_restart(tmp_path):
    db = str(tmp_path / "brain.sqlite")
    model = ScriptedChatModel(script=[AIMessage(content="First reply")])
    async with AsyncSqliteSaver.from_conn_string(db) as saver:
        await collect(build_graph(settings(), saver, model), "remember me", "durable")

    # A brand-new graph and connection, as after a process restart.
    model2 = ScriptedChatModel(script=[AIMessage(content="Second reply")])
    async with AsyncSqliteSaver.from_conn_string(db) as saver:
        graph = build_graph(settings(), saver, model2)
        state = await graph.aget_state({"configurable": {"thread_id": "durable"}})
        assert [m.content for m in state.values["messages"]][:2] == ["remember me", "First reply"]
        await collect(graph, "and again", "durable")
        state = await graph.aget_state({"configurable": {"thread_id": "durable"}})
        assert len(state.values["messages"]) == 4


async def test_per_turn_counters_reset_but_session_total_accumulates():
    paid = tier_for("mid", "fake", "openai/gpt-oss-20b")
    model = ScriptedChatModel(script=[AIMessage(content="One."), AIMessage(content="Two.")])
    graph = build_graph(settings(tiers=[paid]), MemorySaver(), model)
    first = await collect(graph, "a")
    second = await collect(graph, "b")
    d1 = next(e for e in first if isinstance(e, Done))
    d2 = next(e for e in second if isinstance(e, Done))
    assert d2.steps == 1 and d1.steps == 1
    state = await graph.aget_state({"configurable": {"thread_id": "s1"}})
    assert state.values["session_usd"] > d2.turn_usd


class SlowModel(ScriptedChatModel):
    """Blocks long enough for a test to cancel the turn mid-generation."""

    def _generate(self, *a, **k):
        import time

        time.sleep(1.0)
        return super()._generate(*a, **k)

    def _stream(self, *a, **k):
        import time

        time.sleep(1.0)
        yield from super()._stream(*a, **k)


async def test_a_turn_cancelled_by_an_interruption_still_saves_the_callers_message():
    """The checkpoint is written once, when the run ends. An interruption cancels
    the run mid-generation, and /heard assumes the caller's message was saved: if
    it were not, the thread would gain an assistant reply with no question."""
    import asyncio

    g = build_graph(settings(), MemorySaver(), SlowModel(script=[AIMessage(content="never finished")]))
    task = asyncio.create_task(collect(g, "caller said this", "cancelled"))
    await asyncio.sleep(0.3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0.1)
    snapshot = await g.aget_state({"configurable": {"thread_id": "cancelled"}})
    assert [m.content for m in snapshot.values["messages"]] == ["caller said this"]
