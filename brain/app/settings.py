from __future__ import annotations

import os
from dataclasses import dataclass, field

from .cost import Tier, tier_for


def _float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


@dataclass
class Settings:
    provider: str = "fake"  # fake | groq | ollama
    db_path: str = "./data/brain.sqlite"
    turn_budget_usd: float = 0.50
    max_steps: int = 6
    context_window: int = 6000
    reserve_output: int = 512
    tiers: list[Tier] = field(default_factory=list)
    connectors_config: str | None = None  # path to an mcp.json
    approval_ttl_s: int = 600

    @classmethod
    def from_env(cls) -> Settings:
        provider = os.environ.get("BRAIN_PROVIDER", "fake").lower()
        if provider == "groq":
            tiers = [
                tier_for("frontier", "groq", os.environ.get("BRAIN_FRONTIER_MODEL", "openai/gpt-oss-120b")),
                tier_for("mid", "groq", os.environ.get("BRAIN_MID_MODEL", "openai/gpt-oss-20b")),
                tier_for("local", "ollama", os.environ.get("BRAIN_LOCAL_MODEL", "phi3")),
            ]
        elif provider == "ollama":
            tiers = [tier_for("local", "ollama", os.environ.get("BRAIN_LOCAL_MODEL", "phi3"))]
        else:
            tiers = [tier_for("local", "fake", "fake")]
        return cls(
            provider=provider,
            db_path=os.environ.get("BRAIN_DB", "./data/brain.sqlite"),
            turn_budget_usd=_float("BRAIN_TURN_BUDGET_USD", 0.50),
            max_steps=_int("BRAIN_MAX_STEPS", 6),
            context_window=_int("BRAIN_CONTEXT_TOKENS", 6000),
            reserve_output=_int("BRAIN_RESERVE_OUTPUT", 512),
            tiers=tiers,
            connectors_config=os.environ.get("BRAIN_MCP_CONFIG", "./mcp.json"),
            approval_ttl_s=_int("BRAIN_APPROVAL_TTL_S", 600),
        )
