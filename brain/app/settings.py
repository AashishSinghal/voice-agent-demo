from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

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
    # Hosted Postgres (Neon, Supabase, ...). When set it replaces the SQLite file,
    # which does not survive a serverless filesystem.
    database_url: str | None = None
    db_pool_size: int = 3
    db_setup: bool = False  # create checkpoint tables on start; a script does it once in the cloud
    # When set, every /v1 request must carry `Authorization: Bearer <key>`.
    api_key: str | None = None
    # Per-user accounts (Notion). Off unless token_key is set: a connection's
    # token is stored encrypted with it, so there is nothing to keep without one.
    token_key: str | None = None  # a Fernet key (docs/CONNECTIONS.md says how to make one)
    public_url: str = "http://localhost:8000"  # where the provider redirects back to
    notion_client_id: str | None = None
    notion_client_secret: str | None = None
    notion_auth_base: str = "https://api.notion.com"
    notion_api_base: str = "https://api.notion.com"

    @classmethod
    def from_env(cls, load_env: bool = True) -> Settings:
        if load_env:
            # brain/.env fills in anything the process environment does not set,
            # so a hosted platform's real variables always win over the file.
            from dotenv import load_dotenv

            load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
        provider = os.environ.get("BRAIN_PROVIDER", "fake").lower()
        if provider == "groq":
            tiers = [
                tier_for("frontier", "groq", os.environ.get("BRAIN_FRONTIER_MODEL", "openai/gpt-oss-120b")),
                tier_for("mid", "groq", os.environ.get("BRAIN_MID_MODEL", "openai/gpt-oss-20b")),
            ]
            # A local model is a real fallback only where one is running. Listing
            # it by default put a tier that cannot exist in the cloud at the end
            # of the chain, so it is opt-in.
            if os.environ.get("BRAIN_LOCAL_MODEL"):
                tiers.append(tier_for("local", "ollama", os.environ["BRAIN_LOCAL_MODEL"]))
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
            database_url=os.environ.get("BRAIN_DATABASE_URL") or None,
            db_pool_size=_int("BRAIN_DB_POOL_SIZE", 3),
            db_setup=os.environ.get("BRAIN_DB_SETUP", "").lower() in ("1", "true", "yes"),
            api_key=os.environ.get("BRAIN_API_KEY") or None,
            token_key=os.environ.get("BRAIN_TOKEN_KEY") or None,
            public_url=(os.environ.get("BRAIN_PUBLIC_URL") or "http://localhost:8000").rstrip("/"),
            notion_client_id=os.environ.get("NOTION_CLIENT_ID") or None,
            notion_client_secret=os.environ.get("NOTION_CLIENT_SECRET") or None,
            notion_auth_base=os.environ.get("NOTION_AUTH_BASE", "https://api.notion.com").rstrip("/"),
            notion_api_base=os.environ.get("NOTION_API_BASE", "https://api.notion.com").rstrip("/"),
        )
