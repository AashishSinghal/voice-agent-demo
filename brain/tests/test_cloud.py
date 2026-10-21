"""What changes when the brain runs somewhere hosted."""

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from app.cost import tier_for
from app.llm import ScriptedChatModel
from app.main import create_app
from app.settings import Settings
from app.store import pool_kwargs


def make(tmp_path, **kw):
    s = Settings(tiers=[tier_for("local", "fake", "fake")], db_path=str(tmp_path / "b.sqlite"), **kw)
    return create_app(s, ScriptedChatModel(script=[AIMessage(content="Hi from the brain")]))


TURN = {"session_id": "a", "text": "hello"}


# --- shared secret -----------------------------------------------------------


def test_with_no_key_configured_the_api_is_open(tmp_path):
    with TestClient(make(tmp_path)) as c:
        assert c.post("/v1/turn", json=TURN).status_code == 200


@pytest.mark.parametrize(
    ("method", "path"),
    [("post", "/v1/turn"), ("get", "/v1/tools"), ("get", "/v1/threads/a"), ("post", "/v1/threads/a/heard")],
)
def test_every_v1_route_refuses_a_caller_without_the_key(tmp_path, method, path):
    with TestClient(make(tmp_path, api_key="s3cret")) as c:
        body = {"spoken": "x"} if path.endswith("heard") else TURN
        kwargs = {"json": body} if method == "post" else {}
        assert getattr(c, method)(path, **kwargs).status_code == 401


def test_a_wrong_or_malformed_key_is_refused(tmp_path):
    with TestClient(make(tmp_path, api_key="s3cret")) as c:
        for header in ("Bearer nope", "s3cret", "Bearer ", "bearer s3cret", ""):
            r = c.post("/v1/turn", json=TURN, headers={"Authorization": header})
            assert r.status_code == 401, header


def test_the_right_key_is_accepted(tmp_path):
    with TestClient(make(tmp_path, api_key="s3cret")) as c:
        r = c.post("/v1/turn", json=TURN, headers={"Authorization": "Bearer s3cret"})
        assert r.status_code == 200 and "event: done" in r.text


def test_health_reveals_nothing_to_an_anonymous_caller_when_a_key_is_set(tmp_path):
    with TestClient(make(tmp_path, api_key="s3cret")) as c:
        assert c.get("/health").json() == {"status": "ok"}
        full = c.get("/health", headers={"Authorization": "Bearer s3cret"}).json()
        assert full["storage"] == "sqlite" and "connectors" in full


# --- lazy start --------------------------------------------------------------


def test_the_first_request_works_even_if_the_host_never_runs_lifespan(tmp_path):
    """A serverless host may not run startup hooks. TestClient without `with`
    does not run them either, so this is the same situation."""
    c = TestClient(make(tmp_path))
    assert c.post("/v1/turn", json=TURN).status_code == 200
    assert c.get("/v1/threads/a").json()["messages"] == 2


# --- settings ----------------------------------------------------------------


def test_the_groq_chain_has_no_local_tier_unless_one_is_configured(monkeypatch):
    monkeypatch.setenv("BRAIN_PROVIDER", "groq")
    monkeypatch.delenv("BRAIN_LOCAL_MODEL", raising=False)
    assert [t.name for t in Settings.from_env(load_env=False).tiers] == ["frontier", "mid"]
    monkeypatch.setenv("BRAIN_LOCAL_MODEL", "llama3.1:8b")
    assert [t.name for t in Settings.from_env(load_env=False).tiers] == ["frontier", "mid", "local"]


def test_cloud_settings_come_from_the_environment(monkeypatch):
    monkeypatch.setenv("BRAIN_DATABASE_URL", "postgresql://u:p@host/db?sslmode=require")
    monkeypatch.setenv("BRAIN_API_KEY", "k")
    monkeypatch.setenv("BRAIN_DB_SETUP", "true")
    s = Settings.from_env(load_env=False)
    assert s.database_url.startswith("postgresql://") and s.api_key == "k" and s.db_setup is True
    monkeypatch.delenv("BRAIN_DATABASE_URL")
    monkeypatch.delenv("BRAIN_API_KEY")
    monkeypatch.delenv("BRAIN_DB_SETUP")
    s = Settings.from_env(load_env=False)
    assert s.database_url is None and s.api_key is None and s.db_setup is False


# --- the pooled Postgres connection -----------------------------------------


def test_pooled_connections_disable_prepared_statements():
    """Prepared statements break in a pooler's transaction mode, which is how
    Neon and Supabase serve serverless clients."""
    kwargs = pool_kwargs()
    assert kwargs["prepare_threshold"] is None
    assert kwargs["autocommit"] is True


@pytest.mark.skipif(
    not __import__("os").environ.get("BRAIN_TEST_DATABASE_URL"),
    reason="set BRAIN_TEST_DATABASE_URL to run against a real Postgres",
)
async def test_the_checkpoint_survives_a_new_connection_on_real_postgres():
    import os
    import uuid

    from langgraph.checkpoint.memory import MemorySaver  # noqa: F401

    from app.contract import Done, TurnRequest
    from app.graph import build_graph
    from app.store import open_checkpointer
    from app.stream import run_turn

    settings = Settings(
        tiers=[tier_for("local", "fake", "fake")],
        database_url=os.environ["BRAIN_TEST_DATABASE_URL"],
        db_setup=True,
    )
    thread = f"test-{uuid.uuid4()}"
    model = ScriptedChatModel(script=[AIMessage(content="First"), AIMessage(content="Second")])

    async def turn(text):
        async with open_checkpointer(settings) as saver:  # a fresh pool each time
            graph = build_graph(settings, saver, model)
            return [e async for e in run_turn(graph, TurnRequest(session_id=thread, text=text))]

    await turn("one")
    events = await turn("two")
    assert next(e for e in events if isinstance(e, Done)).steps == 1
    async with open_checkpointer(settings) as saver:
        snap = await build_graph(settings, saver, model).aget_state({"configurable": {"thread_id": thread}})
        assert [m.content for m in snap.values["messages"]] == ["one", "First", "two", "Second"]
