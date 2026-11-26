"""Connecting a user's own Notion: the OAuth round trip, the vault, per-owner tools."""

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langgraph.store.memory import InMemoryStore

from app.connections import Connections
from app.cost import tier_for
from app.llm import ScriptedChatModel
from app.main import create_app
from app.oauth import OAuthError, make_state, read_state
from app.settings import Settings
from tests.fake_notion import TOKEN, build
from tests.test_api import parse_sse

KEY = Fernet.generate_key().decode()
ALICE = "a" * 32
BOB = "b" * 32


def brain(tmp_path, script, **kw):
    fake = build()
    s = Settings(
        tiers=[tier_for("local", "fake", "fake")],
        db_path=str(tmp_path / "b.sqlite"),
        token_key=KEY,
        notion_client_id="id",
        notion_client_secret="secret",
        public_url="http://testserver",
        **kw,
    )
    app = create_app(s, ScriptedChatModel(script=script), http_transport=httpx.ASGITransport(app=fake))
    return app, fake


def connect(c, owner):
    url = c.post(f"/v1/owners/{owner}/connections/notion/start").json()["url"]
    state = url.split("state=")[1].split("&")[0]
    return c.get("/oauth/notion/callback", params={"code": "fakecode", "state": state})


def call(name, args, id_):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": id_}])


# --- signed state ---------------------------------------------------------


def test_state_round_trips_and_names_its_owner():
    assert read_state(KEY, make_state(KEY, ALICE, "notion"), "notion") == ALICE


def test_a_forged_expired_or_misdirected_state_is_refused():
    good = make_state(KEY, ALICE, "notion")
    body, sig = good.split(".")
    with pytest.raises(OAuthError):
        read_state(KEY, f"{body}.{sig[:-2]}xx", "notion")
    with pytest.raises(OAuthError):
        read_state("another key", good, "notion")
    with pytest.raises(OAuthError, match="expired"):
        read_state(KEY, make_state(KEY, ALICE, "notion", now=1_000), "notion")
    with pytest.raises(OAuthError, match="another service"):
        read_state(KEY, good, "todoist")


# --- the vault ------------------------------------------------------------


async def test_the_token_is_stored_encrypted_and_only_this_key_reads_it():
    store = InMemoryStore()
    vault = Connections(store, KEY)
    await vault.save(ALICE, "notion", {"access_token": "tok-123"}, {"workspace": "W"})
    raw = (await store.aget(("connections", ALICE), "notion")).value
    assert "tok-123" not in str(raw)
    assert await vault.secret(ALICE, "notion") == {"access_token": "tok-123"}
    assert await vault.secret(BOB, "notion") is None
    assert await Connections(store, Fernet.generate_key().decode()).secret(ALICE, "notion") is None
    assert await vault.listing(ALICE) == [{"service": "notion", "workspace": "W"}]


# --- the flow -------------------------------------------------------------


def test_connecting_lists_the_account_and_disconnecting_removes_it(tmp_path):
    app, _ = brain(tmp_path, [])
    with TestClient(app) as c:
        assert c.get(f"/v1/owners/{ALICE}/connections").json() == {"available": ["notion"], "connected": []}
        r = connect(c, ALICE)
        assert r.status_code == 200 and "connected" in r.text.lower()
        listed = c.get(f"/v1/owners/{ALICE}/connections").json()["connected"]
        assert listed == [{"service": "notion", "workspace": "Fake Workspace"}]
        assert c.get(f"/v1/owners/{BOB}/connections").json()["connected"] == []
        c.delete(f"/v1/owners/{ALICE}/connections/notion")
        assert c.get(f"/v1/owners/{ALICE}/connections").json()["connected"] == []


def test_a_callback_with_a_bad_state_connects_nothing(tmp_path):
    app, _ = brain(tmp_path, [])
    with TestClient(app) as c:
        r = c.get("/oauth/notion/callback", params={"code": "fakecode", "state": "forged.state"})
        assert r.status_code == 400
        assert c.get(f"/v1/owners/{ALICE}/connections").json()["connected"] == []


def test_without_a_token_key_connecting_is_off(tmp_path):
    s = Settings(tiers=[tier_for("local", "fake", "fake")], db_path=str(tmp_path / "b.sqlite"))
    with TestClient(create_app(s, ScriptedChatModel(script=[]))) as c:
        assert c.get(f"/v1/owners/{ALICE}/connections").json() == {"available": [], "connected": []}
        assert c.post(f"/v1/owners/{ALICE}/connections/notion/start").status_code == 404


def test_the_owner_must_look_like_an_owner(tmp_path):
    app, _ = brain(tmp_path, [])
    with TestClient(app) as c:
        assert c.get("/v1/owners/not-hex!/connections").status_code == 400


# --- tools ----------------------------------------------------------------


def results(sse):
    return [e["data"] for e in parse_sse(sse) if e["event"] == "tool_result"]


def test_notion_tools_exist_only_for_the_owner_who_connected(tmp_path):
    script = [call("notion_search", {"query": "ideas"}, "c1"), AIMessage(content="Found it.")]
    app, _ = brain(tmp_path, script)
    with TestClient(app) as c:
        connect(c, ALICE)
        mine = c.post("/v1/turn", json={"session_id": "s1", "text": "find ideas", "owner": ALICE})
        assert "Ideas (id page-1" in results(mine.text)[0]["content"]

    app, _ = brain(tmp_path, [call("notion_search", {"query": "ideas"}, "c2"), AIMessage(content="Sorry.")])
    with TestClient(app) as c:
        connect(c, ALICE)
        theirs = c.post("/v1/turn", json={"session_id": "s2", "text": "find ideas", "owner": BOB})
        assert "There is no tool called notion_search" in results(theirs.text)[0]["content"]
        anon = c.post("/v1/turn", json={"session_id": "s3", "text": "find ideas"})
        assert anon.status_code == 200


def test_adding_a_note_asks_first_and_then_writes_to_the_users_notion(tmp_path):
    script = [
        call("notion_add_note", {"title": "Plan", "text": "ship it"}, "w1"),
        AIMessage(content="Done."),
    ]
    app, fake = brain(tmp_path, script)
    with TestClient(app) as c:
        connect(c, ALICE)
        ask = c.post("/v1/turn", json={"session_id": "s4", "text": "note it", "owner": ALICE})
        events = parse_sse(ask.text)
        assert events[-1]["data"]["awaiting_approval"] is True
        assert 'add a note called "Plan" to your Notion' in "".join(
            e["data"].get("text", "") for e in events if e["event"] == "token"
        )
        assert len(fake.state.pages) == 1  # nothing written before the yes

        yes = c.post("/v1/turn", json={"session_id": "s4", "text": "yes", "owner": ALICE})
        assert results(yes.text)[0]["content"].startswith('Added the note "Plan"')
        assert fake.state.pages["page-2"] == {"title": "Plan", "text": ["ship it"], "parent": "page-1"}


def test_the_model_never_sees_the_token(tmp_path):
    script = [call("notion_search", {"query": "ideas"}, "c1"), AIMessage(content="ok")]
    app, _ = brain(tmp_path, script)
    with TestClient(app) as c:
        connect(c, ALICE)
        r = c.post("/v1/turn", json={"session_id": "s5", "text": "find", "owner": ALICE})
        assert TOKEN not in r.text
        assert TOKEN not in str(c.get("/v1/threads/s5").json())
