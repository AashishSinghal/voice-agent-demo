"""Tool registry.

Every tool declares a risk level alongside its schema. `safe` tools run
immediately; `confirm` tools change something in the outside world and, from
phase 2, pause the graph for approval. The registry is the single place that
knowledge lives, so the graph never has to guess.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from langchain_core.tools import BaseTool, tool

Risk = Literal["safe", "confirm"]


@dataclass(frozen=True)
class Registered:
    tool: BaseTool
    risk: Risk


@tool
def get_current_time() -> str:
    """Return the current date and time in UTC."""
    return datetime.now(UTC).strftime("%A %d %B %Y, %H:%M UTC")


@tool
def add_numbers(a: float, b: float) -> float:
    """Add two numbers."""
    return a + b


REGISTRY: dict[str, Registered] = {t.name: Registered(t, "safe") for t in (get_current_time, add_numbers)}


def all_tools() -> list[BaseTool]:
    return [r.tool for r in REGISTRY.values()]


def risk_of(name: str) -> Risk | None:
    entry = REGISTRY.get(name)
    return entry.risk if entry else None
