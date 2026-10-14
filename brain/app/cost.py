"""Cost guard and degradation chain.

A runaway agent loop is an outage with an invoice. Before every model call the
guard projects what the call could cost and compares it with what is left of
the turn's budget. If the preferred tier does not fit, it steps down the chain
Frontier -> Mid -> Local -> Cache instead of failing. If the loop itself is the
problem (too many steps), it halts.

Prices are USD per million tokens, from the same table the gateway uses, and
are the single place to update.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

PRICES: dict[str, tuple[float, float]] = {
    "openai/gpt-oss-20b": (0.075, 0.3),
    "openai/gpt-oss-120b": (0.15, 0.6),
}


@dataclass(frozen=True)
class Tier:
    name: str  # "frontier" | "mid" | "local"
    provider: str  # "groq" | "ollama" | "fake"
    model: str
    input_per_m: float = 0.0
    output_per_m: float = 0.0

    def cost(self, prompt_tokens: int, completion_tokens: int) -> float:
        return (prompt_tokens * self.input_per_m + completion_tokens * self.output_per_m) / 1_000_000


def tier_for(name: str, provider: str, model: str) -> Tier:
    inp, out = PRICES.get(model, (0.0, 0.0))
    return Tier(name, provider, model, inp, out)


Action = Literal["call", "cache", "halt"]


@dataclass
class Decision:
    action: Action
    tier: Tier | None
    projected_usd: float
    reason: str
    degraded_from: str | None = None


@dataclass
class CostGuard:
    tiers: list[Tier]
    cap_usd: float = 0.50
    max_steps: int = 6
    spent_usd: float = field(default=0.0)

    def select(
        self,
        *,
        prompt_tokens: int,
        max_output_tokens: int,
        steps: int,
        spent_usd: float,
        unavailable: frozenset[str] = frozenset(),
    ) -> Decision:
        if steps >= self.max_steps:
            return Decision("halt", None, 0.0, f"step limit {self.max_steps} reached")

        remaining = self.cap_usd - spent_usd
        preferred = self.tiers[0].name if self.tiers else None
        for tier in self.tiers:
            if tier.name in unavailable:
                continue
            projected = tier.cost(prompt_tokens, max_output_tokens)
            if projected <= remaining or projected == 0.0:
                reason = "within budget"
                degraded = None
                if tier.name != preferred:
                    reason = f"stepped down from {preferred}: projected over remaining ${remaining:.4f}"
                    degraded = preferred
                return Decision("call", tier, projected, reason, degraded)

        return Decision("cache", None, 0.0, f"no tier fits remaining ${max(remaining, 0):.4f}", preferred)
