"""Connectors: MCP servers listed in a config file, no code changes to add one.

    {
      "mcpServers": {
        "notes":  { "builtin": "notes", "scopes": ["notes:read", "notes:write"] },
        "notion": {
          "command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"],
          "env": { "NOTION_TOKEN": "${NOTION_TOKEN}" },
          "policy": { "readOnly": true, "deny": ["API-delete-a-block"] }
        }
      }
    }

The shape follows the `mcpServers` convention other MCP clients use, so an
existing config pastes straight in. Secrets stay out of the file: `${VAR}` is
filled from the environment (and brain/.env).

A third-party server cannot be trusted to scope itself, so the brain enforces a
policy on what it exposes: `readOnly` hides every tool not marked read-only,
`allow` and `deny` are explicit lists, and `unannotated` sets the risk of tools
that carry no annotations (default: confirm). A connector that fails to start is
reported and skipped; one broken server must not take the agent down.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .mcp_client import McpClient
from .tools import Risk, ToolSet, _mcp_tool

log = logging.getLogger("connectors")

REPO_ROOT = Path(__file__).resolve().parents[2]
BUILTIN_SERVERS = {"notes": REPO_ROOT / "mcp" / "notes_server.py"}
_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


# Used when no mcp.json exists, so the agent has a working connector out of the box.
DEFAULT_CONFIG = {
    "mcpServers": {"notes": {"builtin": "notes", "scopes": ["notes:read", "notes:write", "notes:delete"]}}
}
DEFAULT_NOTES_DB = REPO_ROOT / "brain" / "data" / "notes.sqlite"


def default_config() -> dict:
    """The built-in connector, when its script ships with this deployment.

    A hosted bundle contains only brain/, so the notes server is absent there;
    leaving it out beats reporting a failed connector on every start.
    """
    if BUILTIN_SERVERS["notes"].exists():
        return DEFAULT_CONFIG
    return {"mcpServers": {}}


class ConfigError(Exception):
    pass


@dataclass
class Policy:
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


@dataclass
class ConnectorSpec:
    name: str
    command: list[str]
    env: dict[str, str]
    policy: Policy
    prefix: bool  # namespace tool names, so two servers cannot collide
    startup_timeout: float = 30.0  # npx may download the package on first run


@dataclass
class ConnectorStatus:
    name: str
    ok: bool
    tools: list[str] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "ok": self.ok, "tools": self.tools, "error": self.error}


def interpolate(value: str, env: dict[str, str]) -> str:
    def sub(match: re.Match[str]) -> str:
        var = match.group(1)
        if var not in env or not env[var]:
            raise ConfigError(f"environment variable {var} is not set")
        return env[var]

    return _VAR.sub(sub, value)


def parse_spec(name: str, raw: dict[str, Any], env: dict[str, str]) -> ConnectorSpec:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", name):
        raise ConfigError(f"invalid connector name {name!r}")
    policy = Policy.parse(raw.get("policy"))

    if "builtin" in raw:
        script = BUILTIN_SERVERS.get(raw["builtin"])
        if script is None:
            raise ConfigError(f"unknown builtin {raw['builtin']!r}")
        scopes = raw.get("scopes", ["notes:read"])
        return ConnectorSpec(
            name,
            [sys.executable, str(script)],
            {
                "MCP_GRANTED_SCOPES": ",".join(scopes),
                "NOTES_DB": interpolate(raw["db"], env) if "db" in raw else str(DEFAULT_NOTES_DB),
            },
            policy,
            prefix=False,  # we wrote it; short names read better to the model
        )

    command = raw.get("command")
    if not isinstance(command, str) or not command:
        raise ConfigError("needs either 'builtin' or 'command'")
    args = [interpolate(a, env) for a in raw.get("args", [])]
    server_env = {k: interpolate(v, env) for k, v in raw.get("env", {}).items()}
    return ConnectorSpec(
        name,
        [command, *args],
        server_env,
        policy,
        prefix=True,
        startup_timeout=float(raw.get("startupTimeoutSeconds", 30)),
    )


def load_specs(path: Path | None, env: dict[str, str]) -> tuple[list[ConnectorSpec], list[ConnectorStatus]]:
    """Parse the config. Entries that fail to parse become failed statuses."""
    if path is None:
        return [], []
    try:
        config = json.loads(path.read_text()) if path.exists() else default_config()
        servers = config.get("mcpServers", {})
    except (json.JSONDecodeError, AttributeError) as exc:
        return [], [ConnectorStatus(str(path.name), False, error=f"invalid JSON: {exc}")]

    specs: list[ConnectorSpec] = []
    failed: list[ConnectorStatus] = []
    for name, raw in servers.items():
        try:
            specs.append(parse_spec(name, raw, env))
        except ConfigError as exc:
            failed.append(ConnectorStatus(name, False, error=str(exc)))
    return specs, failed


async def connect_all(specs: list[ConnectorSpec], toolset: ToolSet) -> list[ConnectorStatus]:
    statuses: list[ConnectorStatus] = []
    for spec in specs:
        client = McpClient(spec.name, spec.command, spec.env)
        try:
            await client.start(timeout=spec.startup_timeout)
            definitions = [d for d in await client.list_tools() if spec.policy.admits(d)]
            entries = [
                _mcp_tool(
                    client,
                    d,
                    exposed=f"{spec.name}__{d['name']}"[:64] if spec.prefix else None,
                    unannotated=spec.policy.unannotated,
                    force_safe=d["name"] in spec.policy.safe,
                )
                for d in definitions
            ]
            toolset.entries.extend(entries)
            toolset.clients.append(client)
            toolset.__post_init__()  # duplicate-name check
            statuses.append(ConnectorStatus(spec.name, True, [e.name for e in entries]))
            log.info("connector %s: %d tools", spec.name, len(entries))
        except Exception as exc:  # one broken server must not stop the rest
            await client.close()
            statuses.append(ConnectorStatus(spec.name, False, error=f"{type(exc).__name__}: {exc}"))
            log.warning("connector %s failed: %s", spec.name, exc)
    return statuses


def environment() -> dict[str, str]:
    """Process env plus brain/.env, for ${VAR} interpolation."""
    from dotenv import dotenv_values

    values = {k: v for k, v in dotenv_values(REPO_ROOT / "brain" / ".env").items() if v}
    return {**values, **os.environ}
