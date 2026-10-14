import json

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from app.cost import tier_for
from app.llm import ScriptedChatModel
from app.main import create_app
from app.settings import Settings


def parse_sse(text: str):
    events, current = [], {}
    for line in text.splitlines():
        if line.startswith("event:"):
            current["event"] = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            current["data"] = json.loads(line.split(":", 1)[1].strip())
        elif not line.strip() and current:
            events.append(current)
            current = {}
    if current:
        events.append(current)
    return events


def make(tmp_path):
    s = Settings(tiers=[tier_for("local", "fake", "fake")], db_path=str(tmp_path / "b.sqlite"))
    model = ScriptedChatModel(script=[AIMessage(content="Hi from the brain")])
    return create_app(s, model)


def test_health(tmp_path):
    with TestClient(make(tmp_path)) as c:
        body = c.get("/health").json()
        assert body["status"] == "ok" and body["provider"] == "fake"


def test_turn_streams_typed_events(tmp_path):
    with TestClient(make(tmp_path)) as c:
        r = c.post("/v1/turn", json={"session_id": "a", "text": "hello"})
        events = parse_sse(r.text)
        assert events[-1]["event"] == "done"
        assert events[-1]["data"]["text"] == "Hi from the brain"
        assert any(e["event"] == "token" for e in events)


def test_turn_validates_input(tmp_path):
    with TestClient(make(tmp_path)) as c:
        assert c.post("/v1/turn", json={"session_id": "a", "text": ""}).status_code == 422
        assert c.post("/v1/turn", json={"text": "x"}).status_code == 422


def test_thread_endpoint_reports_persisted_messages(tmp_path):
    with TestClient(make(tmp_path)) as c:
        c.post("/v1/turn", json={"session_id": "t", "text": "hello"})
        body = c.get("/v1/threads/t").json()
        assert body["messages"] == 2


def test_heard_rewrites_last_reply_to_what_was_spoken(tmp_path):
    with TestClient(make(tmp_path)) as c:
        c.post("/v1/turn", json={"session_id": "h", "text": "tell me"})
        r = c.post(
            "/v1/threads/h/heard",
            json={"spoken": "Hi from", "unspoken": "the brain and more"},
        )
        assert r.json() == {"updated": True}
        state = c.app.state.graph
        import asyncio

        values = asyncio.run(state.aget_state({"configurable": {"thread_id": "h"}})).values
        last = values["messages"][-1]
        assert last.content == "Hi from"
        assert last.additional_kwargs["interrupted"] and last.additional_kwargs["unspoken"]


def test_heard_with_nothing_spoken_removes_the_reply(tmp_path):
    with TestClient(make(tmp_path)) as c:
        c.post("/v1/turn", json={"session_id": "h2", "text": "tell me"})
        c.post("/v1/threads/h2/heard", json={"spoken": ""})
        assert c.get("/v1/threads/h2").json()["messages"] == 1


def test_heard_appends_when_the_reply_never_reached_the_checkpoint(tmp_path):
    """Interrupted before the graph saved its answer: the thread ends on the
    caller's message. The previous turn's answer must not be overwritten."""
    import asyncio

    from langchain_core.messages import HumanMessage

    with TestClient(make(tmp_path)) as c:
        c.post("/v1/turn", json={"session_id": "p", "text": "first"})
        graph = c.app.state.graph
        cfg = {"configurable": {"thread_id": "p"}}
        asyncio.run(
            graph.aupdate_state(cfg, {"messages": [HumanMessage(content="second")]}, as_node="call_model")
        )
        c.post("/v1/threads/p/heard", json={"spoken": "Partial", "unspoken": "rest"})
        msgs = asyncio.run(graph.aget_state(cfg)).values["messages"]
        assert [m.content for m in msgs] == ["first", "Hi from the brain", "second", "Partial"]
