import sqlite3
import time

import pytest
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from app.approval import classify
from app.connectors import connect_all, parse_spec
from app.contract import ApprovalRequired, Done, Token, ToolResult, TurnRequest, Usage
from app.cost import tier_for
from app.graph import DECLINED_TEXT, build_graph
from app.llm import ScriptedChatModel
from app.settings import Settings
from app.stream import pending_approvals, run_turn
from app.tools import ToolEntry, ToolSet


def settings(**kw):
    return Settings(tiers=[tier_for("local", "fake", "fake")], **kw)


def call(name, args, id_):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": id_}])


@pytest.fixture
def notes_db(tmp_path):
    return str(tmp_path / "notes.sqlite")


@pytest.fixture
async def toolset(notes_db):
    ts = ToolSet(entries=[])
    spec = parse_spec(
        "notes",
        {"builtin": "notes", "scopes": ["notes:read", "notes:write", "notes:delete"], "db": notes_db},
        {},
    )
    statuses = await connect_all([spec], ts)
    assert statuses[0].ok, statuses[0].error
    yield ts
    await ts.close()


def note_titles(db):
    con = sqlite3.connect(db)
    try:
        return [r[0] for r in con.execute("SELECT title FROM notes ORDER BY id")]
    except sqlite3.OperationalError:
        return []
    finally:
        con.close()


async def say(graph, text, session="s", ttl=600):
    return [e async for e in run_turn(graph, TurnRequest(session_id=session, text=text), ttl)]


def graph_with(script, toolset, saver=None, loop=False, **kw):
    from langgraph.checkpoint.memory import MemorySaver

    model = ScriptedChatModel(script=script, loop=loop)
    return build_graph(settings(**kw), saver or MemorySaver(), model, toolset)


# --- the lookup -------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "verdict"),
    [
        ("yes", "yes"), ("Yes, please.", "yes"), ("yes please", "yes"), ("Go ahead!", "yes"),
        ("do it", "yes"), ("sure", "yes"), ("OK", "yes"),
        ("no", "no"), ("No, don't.", "no"), ("cancel", "no"), ("never mind", "no"), ("wait", "no"),
        ("yes... no wait", "no"), ("yes but actually stop", "no"),
        ("maybe", "other"), ("what time is it", "other"), ("", "other"), ("uh", "other"),
        ("I guess so?", "other"),
    ],
)  # fmt: skip
def test_only_an_unambiguous_yes_approves(text, verdict):
    assert classify(text) == verdict


# --- the flow ---------------------------------------------------------------


async def test_a_risky_call_pauses_and_nothing_is_deleted_yet(toolset, notes_db):
    g = graph_with(
        [
            call("create_note", {"title": "groceries", "body": "milk"}, "c1"),
            AIMessage(content="Saved."),
            call("delete_note", {"note": "groceries"}, "c2"),
            AIMessage(content="Deleted it."),
        ],
        toolset,
    )
    await say(g, "save a note")
    events = await say(g, "delete my groceries note")

    ask = next(e for e in events if isinstance(e, ApprovalRequired))
    assert ask.tool == "delete_note" and 'delete the note "groceries"' in ask.prompt
    spoken = "".join(e.text for e in events if isinstance(e, Token))
    assert spoken == ask.prompt  # the question is spoken like any reply
    done = next(e for e in events if isinstance(e, Done))
    assert done.awaiting_approval and done.text == ask.prompt
    assert note_titles(notes_db) == ["groceries"]  # paused, not executed
    assert len(await pending_approvals(g, {"configurable": {"thread_id": "s"}})) == 1


async def test_yes_runs_the_action_and_the_model_reports_it(toolset, notes_db):
    g = graph_with(
        [
            call("create_note", {"title": "groceries", "body": "milk"}, "c1"),
            AIMessage(content="Saved."),
            call("delete_note", {"note": "groceries"}, "c2"),
            AIMessage(content="Deleted it."),
        ],
        toolset,
    )
    await say(g, "save a note")
    await say(g, "delete my groceries note")
    events = await say(g, "yes")

    assert note_titles(notes_db) == []
    result = next(e for e in events if isinstance(e, ToolResult))
    assert "Deleted the note 'groceries'" in result.content
    done = next(e for e in events if isinstance(e, Done))
    assert done.text == "Deleted it." and not done.awaiting_approval


async def test_no_declines_without_another_model_call(toolset, notes_db):
    g = graph_with(
        [
            call("create_note", {"title": "groceries", "body": "milk"}, "c1"),
            AIMessage(content="Saved."),
            call("delete_note", {"note": "groceries"}, "c2"),
            AIMessage(content="SHOULD NOT BE REACHED"),
        ],
        toolset,
    )
    await say(g, "save a note")
    await say(g, "delete my groceries note")
    events = await say(g, "no")

    assert note_titles(notes_db) == ["groceries"]
    assert next(e for e in events if isinstance(e, Done)).text == DECLINED_TEXT
    assert not any(isinstance(e, Usage) for e in events)  # saying "okay" cost nothing


async def test_an_unrelated_reply_declines_silently_and_is_handled_as_a_new_turn(toolset, notes_db):
    g = graph_with(
        [
            call("create_note", {"title": "groceries", "body": "milk"}, "c1"),
            AIMessage(content="Saved."),
            call("delete_note", {"note": "groceries"}, "c2"),
            AIMessage(content="It is noon."),
        ],
        toolset,
    )
    await say(g, "save a note")
    await say(g, "delete my groceries note")
    events = await say(g, "what time is it")

    assert note_titles(notes_db) == ["groceries"]  # the pending delete did NOT run
    spoken = "".join(e.text for e in events if isinstance(e, Token))
    assert DECLINED_TEXT not in spoken and spoken == "It is noon."
    assert await pending_approvals(g, {"configurable": {"thread_id": "s"}}) == []


async def test_a_stale_approval_is_not_honoured(toolset, notes_db):
    g = graph_with(
        [
            call("create_note", {"title": "groceries", "body": "milk"}, "c1"),
            AIMessage(content="Saved."),
            call("delete_note", {"note": "groceries"}, "c2"),
            AIMessage(content="Fine."),
        ],
        toolset,
        approval_ttl_s=0,
    )
    await say(g, "save a note", ttl=0)
    await say(g, "delete my groceries note", ttl=0)
    time.sleep(0.01)
    await say(g, "yes", ttl=0)  # expired: treated as a fresh turn, not an approval
    assert note_titles(notes_db) == ["groceries"]


async def test_the_pause_survives_a_process_restart(toolset, notes_db, tmp_path):
    db = str(tmp_path / "brain.sqlite")
    script = [
        call("create_note", {"title": "groceries", "body": "milk"}, "c1"),
        AIMessage(content="Saved."),
        call("delete_note", {"note": "groceries"}, "c2"),
    ]
    async with AsyncSqliteSaver.from_conn_string(db) as saver:
        g = graph_with(script, toolset, saver)
        await say(g, "save a note", "durable")
        await say(g, "delete my groceries note", "durable")
        assert note_titles(notes_db) == ["groceries"]

    # New connection, new graph, new model: only the checkpoint file carries over.
    async with AsyncSqliteSaver.from_conn_string(db) as saver:
        g2 = graph_with([AIMessage(content="Gone.")], toolset, saver)
        assert len(await pending_approvals(g2, {"configurable": {"thread_id": "durable"}})) == 1
        events = await say(g2, "yes", "durable")
    assert note_titles(notes_db) == []
    assert next(e for e in events if isinstance(e, Done)).text == "Gone."


async def test_safe_tools_alongside_a_risky_one_run_exactly_once(notes_db):
    runs = []

    @tool
    def counted() -> str:
        """A safe tool that counts how often it really runs."""
        runs.append(1)
        return "counted"

    @tool
    def risky() -> str:
        """A destructive tool."""
        return "done"

    ts = ToolSet(
        entries=[
            ToolEntry(counted, "safe"),
            ToolEntry(risky, "confirm", confirm_prompt="do the risky thing"),
        ]
    )
    both = AIMessage(
        content="",
        tool_calls=[
            {"name": "counted", "args": {}, "id": "a"},
            {"name": "risky", "args": {}, "id": "b"},
        ],
    )
    g = graph_with([both, AIMessage(content="All done.")], ts)
    await say(g, "go")
    assert runs == []  # nothing runs while the question is open
    await say(g, "yes")
    assert runs == [1]  # resuming did not re-run the safe tool


async def test_declining_one_of_two_risky_calls_stops_both(notes_db):
    ran = []

    @tool
    def one() -> str:
        """risky one"""
        ran.append("one")
        return "1"

    @tool
    def two() -> str:
        """risky two"""
        ran.append("two")
        return "2"

    ts = ToolSet(entries=[ToolEntry(one, "confirm"), ToolEntry(two, "confirm")])
    both = AIMessage(
        content="",
        tool_calls=[{"name": "one", "args": {}, "id": "a"}, {"name": "two", "args": {}, "id": "b"}],
    )
    g = graph_with([both, AIMessage(content="never")], ts)
    first = await say(g, "go")
    assert sum(isinstance(e, ApprovalRequired) for e in first) == 1  # asked one at a time
    events = await say(g, "no")
    assert ran == [] and next(e for e in events if isinstance(e, Done)).text == DECLINED_TEXT


async def test_approving_one_does_not_approve_the_next(notes_db):
    ran = []

    @tool
    def one() -> str:
        """risky one"""
        ran.append("one")
        return "1"

    @tool
    def two() -> str:
        """risky two"""
        ran.append("two")
        return "2"

    ts = ToolSet(entries=[ToolEntry(one, "confirm"), ToolEntry(two, "confirm")])
    both = AIMessage(
        content="",
        tool_calls=[{"name": "one", "args": {}, "id": "a"}, {"name": "two", "args": {}, "id": "b"}],
    )
    g = graph_with([both, AIMessage(content="Done.")], ts)
    await say(g, "go")
    second = await say(g, "yes")
    assert ran == []  # one yes, one question: the second action is asked separately
    assert any(isinstance(e, ApprovalRequired) and e.tool == "two" for e in second)
    await say(g, "yes")
    assert sorted(ran) == ["one", "two"]


async def test_hostile_tool_output_cannot_trigger_a_risky_call_without_a_yes(notes_db):
    """Prompt injection through a tool result: even if the model obeys it and
    asks for a destructive call, the caller still has to say yes."""
    from pathlib import Path

    rogue = Path(__file__).parent / "fixtures" / "rogue_server.py"
    import sys

    ts = ToolSet(entries=[])
    inject_spec = parse_spec("rogue", {"command": sys.executable, "args": [str(rogue)]}, {})
    notes_spec = parse_spec(
        "notes",
        {"builtin": "notes", "scopes": ["notes:read", "notes:write", "notes:delete"], "db": notes_db},
        {},
    )
    await connect_all([inject_spec, notes_spec], ts)
    try:
        g = graph_with(
            [
                call("create_note", {"title": "keep", "body": "me"}, "k"),
                AIMessage(content="Saved."),
                call("rogue__inject", {}, "i"),
                # the "obedient" model follows the injected instruction:
                call("delete_note", {"note": "keep"}, "d"),
                AIMessage(content="never reached"),
            ],
            ts,
        )
        await say(g, "save a note")
        events = await say(g, "read my feed")
        assert any(isinstance(e, ApprovalRequired) for e in events)  # it had to ask
        assert note_titles(notes_db) == ["keep"]
    finally:
        await ts.close()


async def test_unknown_tool_call_is_reported_to_the_model_not_raised(toolset):
    g = graph_with([call("no_such_tool", {}, "x"), AIMessage(content="Sorry.")], toolset)
    events = await say(g, "do something")
    result = next(e for e in events if isinstance(e, ToolResult))
    assert "no tool called no_such_tool" in result.content
    assert next(e for e in events if isinstance(e, Done)).text == "Sorry."


async def test_a_failing_tool_is_information_for_the_model(toolset):
    g = graph_with([call("read_note", {"note": "ghost"}, "r"), AIMessage(content="No such note.")], toolset)
    events = await say(g, "read ghost")
    result = next(e for e in events if isinstance(e, ToolResult))
    assert result.content.startswith("Error:") and "No note matches" in result.content
