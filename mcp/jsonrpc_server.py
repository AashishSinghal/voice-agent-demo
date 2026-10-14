"""A minimal MCP server, written against the spec with no SDK.

MCP is JSON-RPC 2.0 over a transport; this one speaks the stdio transport:
newline-delimited JSON, requests on stdin, responses on stdout, logs on stderr
(stdout carries nothing but protocol, or the client cannot parse it).

Implemented: initialize / initialized, ping, tools/list, tools/call, and the
JSON-RPC error codes that apply. Not implemented, deliberately: resources,
prompts, sampling, batching (removed from the spec in 2025-06-18) and
pagination. The point is that the protocol is small enough to own.

Scoped credentials. Every tool declares a scope ("notes:read"). The server is
started with the scopes the session was granted. A tool outside them is not
listed, so the model never sees it, and a direct call is refused with -32001.
Least privilege is enforced here, at the capability, not by asking the model to
behave.

Standard library only: this file must run anywhere Python does.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TextIO

SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]

# JSON-RPC 2.0 reserved codes, plus two implementation-defined ones.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
NOT_INITIALIZED = -32002
SCOPE_NOT_GRANTED = -32001


class ToolError(Exception):
    """A failure the model should see and may recover from (bad input, not
    found, ambiguous). Returned as a tool result with isError, not as a
    protocol error: the call itself was well-formed."""


@dataclass
class Tool:
    name: str
    description: str
    input_schema: dict[str, Any]
    scope: str
    handler: Callable[[dict[str, Any]], str]
    read_only: bool = False
    destructive: bool = False
    open_world: bool = False
    confirm_prompt: str | None = None  # e.g. 'delete the note "{note}"'

    def describe(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
            "annotations": {
                "readOnlyHint": self.read_only,
                "destructiveHint": self.destructive,
                "openWorldHint": self.open_world,
            },
            "_meta": {"scope": self.scope},
        }
        if self.confirm_prompt:
            out["_meta"]["confirmPrompt"] = self.confirm_prompt
        return out


_TYPES: dict[str, tuple[type, ...]] = {
    "string": (str,),
    "integer": (int,),
    "number": (int, float),
    "boolean": (bool,),
    "object": (dict,),
    "array": (list,),
}


def validate_arguments(schema: dict[str, Any], args: Any) -> str | None:
    """Check arguments against the small JSON Schema subset tools use.

    Returns an error message, or None. Small models produce malformed calls
    constantly, so this is the line between a clear error and a stack trace.
    """
    if not isinstance(args, dict):
        return "arguments must be an object"
    props = schema.get("properties", {})
    for name in schema.get("required", []):
        if name not in args:
            return f"missing required argument '{name}'"
    for name, value in args.items():
        spec = props.get(name)
        if spec is None:
            return f"unknown argument '{name}'"
        want = spec.get("type")
        if want in _TYPES:
            # bool is an int in Python; never accept it as a number.
            if isinstance(value, bool) and want != "boolean":
                return f"argument '{name}' must be {want}"
            if not isinstance(value, _TYPES[want]):
                return f"argument '{name}' must be {want}"
        if "enum" in spec and value not in spec["enum"]:
            return f"argument '{name}' must be one of {spec['enum']}"
        if isinstance(value, str) and len(value) > spec.get("maxLength", 100_000):
            return f"argument '{name}' is too long"
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in spec and value < spec["minimum"]:
                return f"argument '{name}' must be at least {spec['minimum']}"
            if "maximum" in spec and value > spec["maximum"]:
                return f"argument '{name}' must be at most {spec['maximum']}"
    return None


def _error(id_: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def _result(id_: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


@dataclass
class McpServer:
    name: str
    version: str
    tools: list[Tool]
    granted_scopes: frozenset[str]
    initialized: bool = field(default=False, init=False)

    def _visible(self) -> list[Tool]:
        return [t for t in self.tools if t.scope in self.granted_scopes]

    def handle(self, message: Any) -> dict[str, Any] | None:
        """One decoded message in, one response out (None for notifications).

        Pure: no I/O, so the whole protocol is testable without a subprocess.
        """
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return _error(None, INVALID_REQUEST, "not a JSON-RPC 2.0 message")
        method = message.get("method")
        if not isinstance(method, str):
            return _error(message.get("id"), INVALID_REQUEST, "missing method")

        is_notification = "id" not in message
        id_ = message.get("id")
        params = message.get("params") or {}

        if is_notification:
            if method == "notifications/initialized":
                self.initialized = True
            return None  # notifications never get a response, even on error

        if not isinstance(params, dict):
            return _error(id_, INVALID_PARAMS, "params must be an object")

        if method == "ping":
            return _result(id_, {})
        if method == "initialize":
            return self._initialize(id_, params)
        if not self.initialized:
            return _error(id_, NOT_INITIALIZED, "send initialize, then notifications/initialized")
        if method == "tools/list":
            return _result(id_, {"tools": [t.describe() for t in self._visible()]})
        if method == "tools/call":
            return self._call(id_, params)
        return _error(id_, METHOD_NOT_FOUND, f"method not found: {method}")

    def _initialize(self, id_: Any, params: dict[str, Any]) -> dict[str, Any]:
        requested = params.get("protocolVersion")
        if not isinstance(requested, str):
            return _error(id_, INVALID_PARAMS, "protocolVersion is required")
        # Version negotiation: echo the client's version if supported,
        # otherwise answer with our latest and let the client decide.
        version = requested if requested in SUPPORTED_VERSIONS else SUPPORTED_VERSIONS[0]
        return _result(
            id_,
            {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": self.name, "version": self.version},
            },
        )

    def _call(self, id_: Any, params: dict[str, Any]) -> dict[str, Any]:
        name = params.get("name")
        if not isinstance(name, str):
            return _error(id_, INVALID_PARAMS, "tool name is required")
        tool = next((t for t in self.tools if t.name == name), None)
        if tool is None:
            return _error(id_, INVALID_PARAMS, f"unknown tool: {name}")
        if tool.scope not in self.granted_scopes:
            return _error(id_, SCOPE_NOT_GRANTED, f"scope not granted: {tool.scope}")

        args = params.get("arguments") or {}
        problem = validate_arguments(tool.input_schema, args)
        if problem:
            return _error(id_, INVALID_PARAMS, problem)

        try:
            text = tool.handler(args)
            return _result(id_, {"content": [{"type": "text", "text": text}], "isError": False})
        except ToolError as exc:
            return _result(id_, {"content": [{"type": "text", "text": str(exc)}], "isError": True})
        except Exception as exc:  # a handler bug must not take the server down
            print(f"[{self.name}] handler {name} crashed: {exc!r}", file=sys.stderr)
            return _result(
                id_, {"content": [{"type": "text", "text": "internal error in tool"}], "isError": True}
            )

    def serve(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
        for line in stdin:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                response: dict[str, Any] | None = _error(None, PARSE_ERROR, "parse error")
            else:
                # Batching was removed from the spec; reject rather than guess.
                response = (
                    _error(None, INVALID_REQUEST, "batching is not supported")
                    if isinstance(message, list)
                    else self.handle(message)
                )
            if response is not None:
                stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
                stdout.flush()
