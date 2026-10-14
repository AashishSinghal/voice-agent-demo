"""The MCP server's protocol, tested without a subprocess (handle() is pure)."""

import importlib.util
import sys
from pathlib import Path

import pytest

MCP_DIR = Path(__file__).resolve().parents[2] / "mcp"
sys.path.insert(0, str(MCP_DIR))
from jsonrpc_server import (  # noqa: E402
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    NOT_INITIALIZED,
    SCOPE_NOT_GRANTED,
    McpServer,
    Tool,
    ToolError,
    validate_arguments,
)


def make(scopes=("s:read",)):
    def boom(_):
        raise RuntimeError("bug")

    def refuse(_):
        raise ToolError("not found")

    tools = [
        Tool("echo", "Echo", {"type": "object", "properties": {"text": {"type": "string"}},
                              "required": ["text"]}, "s:read", lambda a: a["text"], read_only=True),
        Tool("wipe", "Wipe", {"type": "object", "properties": {}}, "s:delete", lambda a: "wiped",
             destructive=True),
        Tool("boom", "Crashes", {"type": "object", "properties": {}}, "s:read", boom),
        Tool("refuse", "Refuses", {"type": "object", "properties": {}}, "s:read", refuse),
    ]  # fmt: skip
    return McpServer("t", "1", tools, frozenset(scopes))


def ready(scopes=("s:read",)):
    server = make(scopes)
    server.handle({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                   "params": {"protocolVersion": "2025-06-18"}})  # fmt: skip
    server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
    return server


def call(server, name, args=None, id_=1):
    return server.handle({"jsonrpc": "2.0", "id": id_, "method": "tools/call",
                          "params": {"name": name, "arguments": args or {}}})  # fmt: skip


def test_initialize_negotiates_version():
    s = make()
    ok = s.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                   "params": {"protocolVersion": "2024-11-05"}})  # fmt: skip
    assert ok["result"]["protocolVersion"] == "2024-11-05"
    unknown = make().handle({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                             "params": {"protocolVersion": "1999-01-01"}})  # fmt: skip
    assert unknown["result"]["protocolVersion"] == "2025-06-18"  # our latest; client decides
    assert (
        s.handle({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {}})["error"]["code"]
        == INVALID_PARAMS
    )


def test_requests_before_initialize_are_refused():
    r = make().handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r["error"]["code"] == NOT_INITIALIZED


def test_notifications_get_no_response_even_when_unknown():
    s = make()
    assert s.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    assert s.handle({"jsonrpc": "2.0", "method": "nonsense"}) is None


def test_ping_works_before_initialize():
    assert make().handle({"jsonrpc": "2.0", "id": 9, "method": "ping"})["result"] == {}


@pytest.mark.parametrize("bad", [None, 5, "x", [], {"id": 1}, {"jsonrpc": "1.0", "id": 1, "method": "x"},
                                  {"jsonrpc": "2.0", "id": 1, "method": 7}])  # fmt: skip
def test_malformed_messages_are_invalid_requests(bad):
    assert make().handle(bad)["error"]["code"] == INVALID_REQUEST


def test_unknown_method():
    r = ready().handle({"jsonrpc": "2.0", "id": 1, "method": "resources/list"})
    assert r["error"]["code"] == METHOD_NOT_FOUND


def test_tools_list_hides_tools_outside_granted_scopes():
    names = [
        t["name"]
        for t in ready().handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]
    ]
    assert "echo" in names and "wipe" not in names
    names = [
        t["name"]
        for t in ready(("s:read", "s:delete")).handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})[
            "result"
        ]["tools"]
    ]
    assert "wipe" in names


def test_calling_an_ungranted_tool_is_refused_even_if_guessed():
    assert call(ready(), "wipe")["error"]["code"] == SCOPE_NOT_GRANTED


def test_tool_descriptions_carry_annotations_and_scope():
    tools = ready(("s:read", "s:delete")).handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})[
        "result"
    ]["tools"]
    wipe = next(t for t in tools if t["name"] == "wipe")
    assert wipe["annotations"]["destructiveHint"] is True and wipe["_meta"]["scope"] == "s:delete"


def test_successful_call():
    r = call(ready(), "echo", {"text": "hi"})["result"]
    assert r == {"content": [{"type": "text", "text": "hi"}], "isError": False}


def test_tool_error_is_a_result_not_a_protocol_error():
    r = call(ready(), "refuse")
    assert r["result"]["isError"] is True and "error" not in r


def test_handler_crash_does_not_leak_internals_or_kill_the_server():
    s = ready()
    r = call(s, "boom")["result"]
    assert r["isError"] is True and "bug" not in r["content"][0]["text"]
    assert call(s, "echo", {"text": "still alive"})["result"]["isError"] is False


def test_unknown_tool_and_bad_arguments_are_invalid_params():
    s = ready()
    assert call(s, "nope")["error"]["code"] == INVALID_PARAMS
    assert call(s, "echo", {})["error"]["code"] == INVALID_PARAMS
    assert call(s, "echo", {"text": 5})["error"]["code"] == INVALID_PARAMS
    assert call(s, "echo", {"text": "x", "extra": 1})["error"]["code"] == INVALID_PARAMS


@pytest.mark.parametrize(
    ("schema", "args", "ok"),
    [
        ({"type": "object", "properties": {"n": {"type": "integer"}}}, {"n": True}, False),
        ({"type": "object", "properties": {"n": {"type": "integer"}}}, {"n": 3}, True),
        ({"type": "object", "properties": {"n": {"type": "number"}}}, {"n": 1.5}, True),
        ({"type": "object", "properties": {"n": {"type": "integer", "minimum": 1}}}, {"n": 0}, False),
        ({"type": "object", "properties": {"n": {"type": "integer", "maximum": 5}}}, {"n": 6}, False),
        ({"type": "object", "properties": {"e": {"enum": ["a", "b"]}}}, {"e": "c"}, False),
        ({"type": "object", "properties": {"s": {"type": "string", "maxLength": 3}}}, {"s": "abcd"}, False),
        ({"type": "object", "properties": {}}, "not-an-object", False),
    ],
)
def test_argument_validation(schema, args, ok):
    assert (validate_arguments(schema, args) is None) is ok


def test_serve_loop_handles_garbage_batches_and_blank_lines():
    import io
    import json

    server = make()
    stdin = io.StringIO('\n{not json}\n[{"jsonrpc":"2.0","id":1,"method":"ping"}]\n'
                        '{"jsonrpc":"2.0","id":2,"method":"ping"}\n')  # fmt: skip
    out = io.StringIO()
    server.serve(stdin, out)
    lines = [json.loads(line) for line in out.getvalue().splitlines()]
    assert lines[0]["error"]["code"] == -32700
    assert lines[1]["error"]["code"] == INVALID_REQUEST  # batching rejected
    assert lines[2]["result"] == {}
    assert len(lines) == 3


def test_notes_server_module_builds_with_expected_scopes(monkeypatch, tmp_path):
    monkeypatch.setenv("NOTES_DB", str(tmp_path / "n.sqlite"))
    monkeypatch.setenv("MCP_GRANTED_SCOPES", "notes:read,notes:write")
    spec = importlib.util.spec_from_file_location("notes_server", MCP_DIR / "notes_server.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    server = mod.build()
    server.handle(
        {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}
    )
    server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
    names = {
        t["name"]
        for t in server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]
    }
    assert names == {"create_note", "list_notes", "search_notes", "read_note"}  # no delete_note
    assert (
        call(server, "create_note", {"title": "Milk", "body": "buy oat milk"})["result"]["isError"] is False
    )
    assert "oat milk" in call(server, "search_notes", {"query": "oat"})["result"]["content"][0]["text"]
    assert call(server, "delete_note", {"note": "Milk"})["error"]["code"] == SCOPE_NOT_GRANTED
