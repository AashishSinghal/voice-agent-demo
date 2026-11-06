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
from langchain_core.utils.function_calling import convert_to_openai_tool

from .mcp_client import McpClient, McpError

Risk = Literal["safe", "confirm"]


class ConfigError(Exception):
    pass


@dataclass
class Policy:
    """What the brain lets a third-party server expose, and how risky each tool is.

    A server cannot be trusted to scope itself, so this is enforced here, in the
    one place tools enter the registry.
    """

    read_only: bool = False
    allow: list[str] | None = None
    deny: list[str] = field(default_factory=list)
    unannotated: Risk = "confirm"
    # Tools the user vouches for as safe despite the server's annotations, e.g.
    # a search that is a POST. An explicit opt-in per tool, never a blanket.
    safe: list[str] = field(default_factory=list)

    @classmethod
    def parse(cls, raw: dict[str, Any] | None) -> Policy:
        raw = raw or {}
        unannotated = raw.get("unannotated", "confirm")
        if unannotated not in ("safe", "confirm"):
            raise ConfigError("policy.unannotated must be 'safe' or 'confirm'")
        return cls(
            read_only=bool(raw.get("readOnly", False)),
            allow=raw.get("allow"),
            deny=list(raw.get("deny", [])),
            unannotated=unannotated,
            safe=list(raw.get("safe", [])),
        )

    def admits(self, definition: dict[str, Any]) -> bool:
        name = definition["name"]
        if name in self.deny:
            return False
        if self.allow is not None and name not in self.allow:
            return False
        if self.read_only and not (definition.get("annotations") or {}).get("readOnlyHint"):
            return False
        return True


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
    """Every tool the model can call, and the one place that decides which.

    The graph asks this at run time rather than keeping its own list, so a
    connector added later is visible on the next model call.
    """

    entries: list[ToolEntry] = field(default_factory=local_entries)
    clients: list[McpClient] = field(default_factory=list)
    _schemas: list[dict] | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        self._require_unique(self.entries)

    @staticmethod
    def _require_unique(entries: list[ToolEntry]) -> None:
        names = [e.name for e in entries]
        dupes = {n for n in names if names.count(n) > 1}
        if dupes:
            raise ValueError(f"duplicate tool names across connectors: {sorted(dupes)}")

    def get(self, name: str) -> ToolEntry | None:
        return next((e for e in self.entries if e.name == name), None)

    def tools(self) -> list[BaseTool]:
        return [e.tool for e in self.entries]

    def schemas(self) -> list[dict]:
        """The tools as the model sees them; rebuilt only when the set changes."""
        if self._schemas is None:
            self._schemas = [convert_to_openai_tool(t) for t in self.tools()]
        return self._schemas

    async def add_connector(
        self,
        client: McpClient,
        policy: Policy | None = None,
        *,
        namespace: str | None = None,
        startup_timeout: float = 30.0,
    ) -> list[str]:
        """Start a server and admit its tools. The only way a connector gets in.

        `namespace` prefixes tool names so two servers cannot collide. On any
        failure the client is closed and nothing is added.
        """
        policy = policy or Policy()
        try:
            await client.start(timeout=startup_timeout)
            definitions = [d for d in await client.list_tools() if policy.admits(d)]
            added = [
                _mcp_tool(
                    client,
                    d,
                    exposed=f"{namespace}__{d['name']}"[:64] if namespace else None,
                    unannotated=policy.unannotated,
                    force_safe=d["name"] in policy.safe,
                )
                for d in definitions
            ]
            self._require_unique([*self.entries, *added])
        except Exception:
            await client.close()
            raise
        self.entries.extend(added)
        self.clients.append(client)
        self._schemas = None
        return [e.name for e in added]

    async def close(self) -> None:
        for client in self.clients:
            await client.close()
