"""A minimal async MCP client over stdio, written against the spec.

It spawns a server as a subprocess and speaks newline-delimited JSON-RPC 2.0.
Requests are matched to responses by id, so concurrent calls are safe. If the
server dies, every outstanding request fails immediately instead of hanging a
voice call, and timeouts bound the rest.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import os
from collections.abc import Mapping
from typing import Any

log = logging.getLogger("mcp")

PROTOCOL_VERSION = "2025-06-18"
READ_LIMIT = 1024 * 1024  # a tool result can be a large note

# A spawned server is third-party code. It gets a minimal environment plus
# exactly what its config names, never the brain's own secrets (GROQ_API_KEY).
INHERITED_ENV = ("PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TERM", "SHELL")


class McpError(Exception):
    """A JSON-RPC error response, or a transport failure."""

    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


class McpClient:
    def __init__(self, name: str, command: list[str], env: Mapping[str, str] | None = None):
        self.name = name
        self.command = command
        self.env = dict(env or {})
        self._proc: asyncio.subprocess.Process | None = None
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._tasks: list[asyncio.Task[None]] = []
        self.server_info: dict[str, Any] = {}

    async def start(self, timeout: float = 10.0) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={k: os.environ[k] for k in INHERITED_ENV if k in os.environ} | self.env,
            limit=READ_LIMIT,
        )
        self._tasks = [
            asyncio.create_task(self._read_stdout()),
            asyncio.create_task(self._read_stderr()),
        ]
        result = await self.request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "voice-agent-brain", "version": "0.1.0"},
            },
            timeout=timeout,
        )
        self.server_info = result.get("serverInfo", {})
        await self.notify("notifications/initialized")

    async def _send(self, message: dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.returncode is not None:
            raise McpError(f"{self.name}: server is not running")
        proc.stdin.write((json.dumps(message, separators=(",", ":")) + "\n").encode())
        await proc.stdin.drain()

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params:
            message["params"] = params
        await self._send(message)

    async def request(
        self, method: str, params: dict[str, Any] | None = None, timeout: float = 10.0
    ) -> dict[str, Any]:
        id_ = next(self._ids)
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[id_] = future
        try:
            await self._send({"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}})
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            raise McpError(f"{self.name}: {method} timed out after {timeout}s") from None
        finally:
            self._pending.pop(id_, None)

    async def list_tools(self) -> list[dict[str, Any]]:
        return (await self.request("tools/list")).get("tools", [])

    async def call_tool(
        self, name: str, arguments: dict[str, Any], timeout: float = 15.0
    ) -> tuple[str, bool]:
        """Returns (text, is_error). Protocol errors raise McpError; a tool that
        ran and failed (not found, ambiguous) comes back with is_error=True so
        the model can read it and recover."""
        result = await self.request("tools/call", {"name": name, "arguments": arguments}, timeout)
        text = "\n".join(
            block.get("text", "") for block in result.get("content", []) if block.get("type") == "text"
        )
        return text, bool(result.get("isError"))

    async def _read_stdout(self) -> None:
        assert self._proc and self._proc.stdout
        try:
            async for raw in self._proc.stdout:
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("%s: ignoring non-JSON line on stdout", self.name)
                    continue
                future = self._pending.get(message.get("id")) if isinstance(message, dict) else None
                if future is None or future.done():
                    continue  # a notification, or a response we gave up on
                if "error" in message:
                    err = message["error"]
                    future.set_exception(McpError(err.get("message", "error"), err.get("code")))
                else:
                    future.set_result(message.get("result", {}))
        finally:
            self._fail_pending("server closed the connection")

    async def _read_stderr(self) -> None:
        assert self._proc and self._proc.stderr
        async for raw in self._proc.stderr:
            log.info("%s: %s", self.name, raw.decode(errors="replace").rstrip())

    def _fail_pending(self, reason: str) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(McpError(f"{self.name}: {reason}"))

    async def close(self) -> None:
        proc = self._proc
        if proc and proc.returncode is None:
            if proc.stdin:
                proc.stdin.close()  # a well-behaved server exits on EOF
            try:
                await asyncio.wait_for(proc.wait(), 2)
            except TimeoutError:
                proc.kill()
                await proc.wait()
        for task in self._tasks:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
