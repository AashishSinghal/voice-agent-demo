import asyncio
import json
import sys
from pathlib import Path

import pytest

from app.connectors import Policy, connect_all, interpolate, load_specs, parse_spec
from app.mcp_client import McpClient, McpError
from app.tools import ToolSet, risk_from_annotations

ROGUE = [sys.executable, str(Path(__file__).parent / "fixtures" / "rogue_server.py")]


def rogue_spec(policy=None, env=None, name="rogue"):
    return parse_spec(
        name,
        {"command": ROGUE[0], "args": ROGUE[1:], "policy": policy or {}, "env": env or {}},
        {},
    )


@pytest.fixture
async def toolset():
    ts = ToolSet(entries=[])
    yield ts
    await ts.close()


# --- the client against a server we did not write -------------------------


async def test_client_handshake_list_and_call():
    c = McpClient("rogue", ROGUE)
    await c.start()
    try:
        assert c.server_info["name"] == "rogue"
        assert {t["name"] for t in await c.list_tools()} >= {"plain", "reader"}
        assert await c.call_tool("plain", {}) == ("plain ok", False)
    finally:
        await c.close()


async def test_concurrent_calls_are_matched_to_their_own_responses():
    c = McpClient("rogue", ROGUE)
    await c.start()
    try:
        results = await asyncio.gather(*(c.call_tool("plain", {"x": str(i)}) for i in range(20)))
        assert all(r == ("plain ok", False) for r in results)
    finally:
        await c.close()


async def test_a_hung_tool_times_out_instead_of_hanging_the_call():
    c = McpClient("rogue", ROGUE)
    await c.start()
    try:
        with pytest.raises(McpError, match="timed out"):
            await c.call_tool("hang", {}, timeout=0.4)
    finally:
        await c.close()


async def test_server_death_fails_outstanding_calls_immediately():
    c = McpClient("rogue", ROGUE)
    await c.start()
    try:
        started = asyncio.get_running_loop().time()
        with pytest.raises(McpError, match="closed|not running"):
            await c.call_tool("die", {}, timeout=10)
        assert asyncio.get_running_loop().time() - started < 3  # not the 10s timeout
        with pytest.raises(McpError):
            await c.call_tool("plain", {})  # and later calls fail cleanly
    finally:
        await c.close()


async def test_protocol_errors_surface_with_their_code():
    c = McpClient("rogue", ROGUE)
    await c.start()
    try:
        with pytest.raises(McpError) as e:
            await c.request("resources/list")
        assert e.value.code == -32601
    finally:
        await c.close()


async def test_spawned_server_cannot_see_the_brains_secrets(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_super_secret")
    c = McpClient("rogue", ROGUE, {"CUSTOM_TOKEN": "granted"})
    await c.start()
    try:
        text, _ = await c.call_tool("env_check", {})
        assert text == "groq=False custom=granted"  # only what the config named
    finally:
        await c.close()


# --- config and policy -----------------------------------------------------


def test_interpolation_fills_variables_and_refuses_missing_ones():
    assert interpolate("Bearer ${TOK}", {"TOK": "abc"}) == "Bearer abc"
    with pytest.raises(Exception, match="TOK is not set"):
        interpolate("${TOK}", {})
    with pytest.raises(Exception, match="TOK is not set"):
        interpolate("${TOK}", {"TOK": ""})


def test_policy_read_only_allow_and_deny():
    d = lambda n, ro=False: {"name": n, "annotations": {"readOnlyHint": ro}}  # noqa: E731
    assert Policy.parse({"readOnly": True}).admits(d("a", True))
    assert not Policy.parse({"readOnly": True}).admits(d("a", False))
    assert not Policy.parse({"deny": ["a"]}).admits(d("a", True))
    assert Policy.parse({"allow": ["a"]}).admits(d("a")) and not Policy.parse({"allow": ["a"]}).admits(d("b"))
    assert not Policy.parse({"readOnly": True}).admits({"name": "x"})  # no annotations: not read-only
    with pytest.raises(Exception, match="unannotated"):
        Policy.parse({"unannotated": "yolo"})


def test_risk_follows_the_spec_defaults():
    assert risk_from_annotations({"readOnlyHint": True}) == "safe"
    assert risk_from_annotations({"destructiveHint": True}) == "confirm"
    assert risk_from_annotations({"readOnlyHint": False}) == "confirm"  # spec: assume destructive
    assert (
        risk_from_annotations({"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False})
        == "safe"
    )
    assert risk_from_annotations({"readOnlyHint": False, "destructiveHint": False}) == "confirm"  # open world
    assert risk_from_annotations(None) == "confirm"
    assert risk_from_annotations({}, unannotated="safe") == "safe"


async def test_third_party_tools_are_namespaced_and_unannotated_ones_need_approval(toolset):
    status = await connect_all([rogue_spec()], toolset)
    assert status[0].ok
    plain = toolset.get("rogue__plain")
    assert plain is not None and plain.risk == "confirm"  # said nothing, so not trusted
    assert toolset.get("rogue__reader").risk == "safe"
    assert toolset.get("plain") is None  # never exposed under the bare name


async def test_policy_hides_tools_from_the_model_entirely(toolset):
    await connect_all([rogue_spec({"readOnly": True, "deny": ["inject"]})], toolset)
    names = {e.name for e in toolset.entries}
    assert names == {"rogue__reader", "rogue__env_check"}  # plain/hang/die/inject all absent


async def test_a_broken_connector_is_reported_and_the_rest_still_load(toolset):
    bad = parse_spec("bad", {"command": "definitely-not-a-real-binary"}, {})
    statuses = await connect_all([bad, rogue_spec(name="good")], toolset)
    assert [s.ok for s in statuses] == [False, True]
    assert statuses[0].error
    assert toolset.get("good__plain")


async def test_two_servers_cannot_collide_on_tool_names(toolset):
    await connect_all([rogue_spec(name="a"), rogue_spec(name="b")], toolset)
    assert toolset.get("a__plain") and toolset.get("b__plain")


def test_unset_secret_in_config_fails_that_connector_only(tmp_path):
    cfg = tmp_path / "mcp.json"
    cfg.write_text(json.dumps({"mcpServers": {
        "ok": {"command": "echo"},
        "needs_secret": {"command": "echo", "env": {"TOKEN": "${NOT_SET_ANYWHERE}"}},
    }}))  # fmt: skip
    specs, failed = load_specs(cfg, {})
    assert [s.name for s in specs] == ["ok"]
    assert failed[0].name == "needs_secret" and "NOT_SET_ANYWHERE" in failed[0].error


def test_invalid_config_json_is_reported_not_raised(tmp_path):
    cfg = tmp_path / "mcp.json"
    cfg.write_text("{nope")
    specs, failed = load_specs(cfg, {})
    assert specs == [] and "invalid JSON" in failed[0].error


def test_missing_config_falls_back_to_the_builtin_notes_connector(tmp_path):
    specs, failed = load_specs(tmp_path / "absent.json", {})
    assert [s.name for s in specs] == ["notes"] and failed == []
    assert specs[0].env["MCP_GRANTED_SCOPES"] == "notes:read,notes:write,notes:delete"
    assert load_specs(None, {}) == ([], [])


def test_connector_names_are_validated():
    with pytest.raises(Exception, match="invalid connector name"):
        parse_spec("bad name!", {"command": "x"}, {})
    with pytest.raises(Exception, match="unknown builtin"):
        parse_spec("n", {"builtin": "nope"}, {})
    with pytest.raises(Exception, match="needs either"):
        parse_spec("n", {}, {})
