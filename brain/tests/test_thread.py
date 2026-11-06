"""The thread module, driven directly: no HTTP, no server."""

from langchain_core.messages import AIMessage, HumanMessage

from app.contract import HeardRequest
from app.thread import Threads
from tests.test_approval import graph_with, say


async def _seed(session: str):
    from tests.test_approval import toolset  # noqa: F401  (fixture module only for helpers)

    return session


async def test_a_heard_report_applies_once_and_leaves_earlier_turns_alone():
    from app.tools import ToolSet

    g = graph_with([AIMessage(content="One."), AIMessage(content="Two.")], ToolSet(entries=[]))
    await say(g, "first", session="t")
    await say(g, "second", session="t")
    threads = Threads(g)

    report = HeardRequest(spoken="", report_id="r1")
    assert await threads.apply_heard("t", report) == {"updated": True}
    assert await threads.apply_heard("t", report) == {"updated": False, "duplicate": True}
    texts = [m["content"] for m in (await threads.history("t"))["history"]]
    assert texts == ["first", "One.", "second"]


async def test_a_report_for_a_reply_that_never_saved_is_appended_not_overwriting():
    from app.tools import ToolSet

    g = graph_with([AIMessage(content="One.")], ToolSet(entries=[]))
    await say(g, "first", session="u")
    await g.aupdate_state(
        {"configurable": {"thread_id": "u"}}, {"messages": [HumanMessage(content="second")]}, as_node="call_model"
    )
    threads = Threads(g)
    await threads.apply_heard("u", HeardRequest(spoken="Par", unspoken="tial"))
    history = (await threads.history("u"))["history"]
    assert [m["content"] for m in history] == ["first", "One.", "second", "Par"]
    assert history[-1]["interrupted"] and history[-1]["unspoken"] == "tial"


async def test_an_unknown_thread_is_empty_not_an_error():
    from app.tools import ToolSet

    g = graph_with([], ToolSet(entries=[]))
    assert (await Threads(g).history("nobody"))["messages"] == 0
    assert await Threads(g).apply_heard("nobody", HeardRequest(spoken="x")) == {"updated": False}
