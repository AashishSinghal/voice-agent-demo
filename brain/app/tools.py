"""Tool registry.

A tool is a LangChain tool plus a risk level. `safe` tools run at once;
`confirm` tools change something in the outside world, so the graph pauses and
asks the caller first. Local tools declare their risk in code; tools that come
from an MCP server derive it from the server's own annotations, so a connector
cannot quietly ship a destructive tool as a safe one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from langchain_core.tools import BaseTool, StructuredTool, tool

from .mcp_client import McpClient, McpError

Risk = Literal["safe", "confirm"]


@dataclass(frozen=True)
class ToolEntry:
    tool: BaseTool
    risk: Risk
    connector: str = "local"
    confirm_prompt: str | None = None  # 'delete the note "{note}"'

    @property
    def name(self) -> str:
        return self.tool.name

    def describe_action(self, args: dict[str, Any]) -> str:
        """What the agent says out loud before asking for approval."""
        if self.confirm_prompt:
            try:
                return self.confirm_prompt.format(**args)
            except (KeyError, IndexError):
                pass
        shown = ", ".join(f"{k} {v}" for k, v in args.items())
        return f"run {self.name.replace('_', ' ')}" + (f" with {shown}" if shown else "")


@tool
def get_current_time() -> str:
    """Return the current date and time in UTC."""
    return datetime.now(UTC).strftime("%A %d %B %Y, %H:%M UTC")


@tool
def add_numbers(a: float, b: float) -> float:
    """Add two numbers."""
    return a + b


def local_entries() -> list[ToolEntry]:
    return [ToolEntry(t, "safe") for t in (get_current_time, add_numbers)]


def risk_from_annotations(annotations: dict[str, Any] | None, unannotated: Risk = "confirm") -> Risk:
    """Map MCP tool annotations to a risk level, using the spec's own defaults.

    Per the spec a tool that is not read-only is assumed destructive and
    open-world unless it says otherwise, so a server has to opt in to being
    safe. A server that sends no annotations at all gets `unannotated`
    (confirm): absence of a warning is not evidence of safety.
    """
    if not annotations:
        return unannotated
    if annotations.get("readOnlyHint"):
        return "safe"
    destructive = annotations.get("destructiveHint", True)
    open_world = annotations.get("openWorldHint", True)
    return "confirm" if destructive or open_world else "safe"


def _mcp_tool(
    client: McpClient,
    definition: dict[str, Any],
    exposed: str | None = None,
    unannotated: Risk = "confirm",
    force_safe: bool = False,
) -> ToolEntry:
    name = definition["name"]  # what the server calls it
    shown = exposed or name  # what the model calls it

    async def call(**kwargs: Any) -> str:
        try:
            text, is_error = await client.call_tool(name, kwargs)
        except McpError as exc:
            return f"The {client.name} connector failed: {exc}"
        return f"Error: {text}" if is_error else text

    meta = definition.get("_meta", {})
    structured = StructuredTool(
        name=shown,
        description=definition.get("description", name),
        args_schema=definition.get("inputSchema", {"type": "object", "properties": {}}),
        coroutine=call,
    )
    return ToolEntry(
        structured,
        "safe" if force_safe else risk_from_annotations(definition.get("annotations"), unannotated),
        connector=client.name,
        confirm_prompt=meta.get("confirmPrompt"),
    )


@dataclass
class ToolSet:
    entries: list[ToolEntry] = field(default_factory=local_entries)
    clients: list[McpClient] = field(default_factory=list)

    def __post_init__(self) -> None:
        names = [e.name for e in self.entries]
        dupes = {n for n in names if names.count(n) > 1}
        if dupes:
            raise ValueError(f"duplicate tool names across connectors: {sorted(dupes)}")

    def get(self, name: str) -> ToolEntry | None:
        return next((e for e in self.entries if e.name == name), None)

    def tools(self) -> list[BaseTool]:
        return [e.tool for e in self.entries]

    async def connect(self, client: McpClient) -> None:
        await client.start()
        self.clients.append(client)
        self.entries.extend(_mcp_tool(client, d) for d in await client.list_tools())
        # Re-run the duplicate check now that connector tools are in.
        self.__post_init__()

    async def close(self) -> None:
        for client in self.clients:
            await client.close()
