"""The gateway <-> brain wire contract. See docs/CONTRACT.md.

The gateway sends one TurnRequest and receives a stream of events. It never
learns which model, graph or tool ran, only what happened.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field


class TurnRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=4000)


class HeardRequest(BaseModel):
    """What the caller actually heard of the last reply, after an interruption."""

    spoken: str = Field(max_length=8000)
    unspoken: str | None = Field(default=None, max_length=8000)


class Token(BaseModel):
    type: Literal["token"] = "token"
    text: str


class ToolCall(BaseModel):
    type: Literal["tool_call"] = "tool_call"
    id: str
    name: str
    args: dict


class ToolResult(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    id: str
    name: str
    content: str


class Context(BaseModel):
    type: Literal["context"] = "context"
    report: dict


class Usage(BaseModel):
    type: Literal["usage"] = "usage"
    tier: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    usd: float
    turn_usd: float
    degraded_from: str | None = None


class Done(BaseModel):
    type: Literal["done"] = "done"
    text: str
    turn_usd: float
    steps: int
    degraded: bool = False


class Error(BaseModel):
    type: Literal["error"] = "error"
    message: str


Event = Annotated[
    Token | ToolCall | ToolResult | Context | Usage | Done | Error,
    Field(discriminator="type"),
]
