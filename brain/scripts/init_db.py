"""Create the checkpoint tables in the configured Postgres, once.

    uv run python scripts/init_db.py

Reads BRAIN_DATABASE_URL (from brain/.env or the environment). If
BRAIN_DATABASE_URL_DIRECT is set it is used instead: table creation is a
migration, and a pooler in transaction mode is built for short queries, not for
that. Use the direct (non-pooled) connection string for this script and the
pooled one for the running service.

Safe to run again: it only creates what is missing. The running service does not
do this on cold start (BRAIN_DB_SETUP is off), because it would cost a round
trip to the database on every wake-up.
"""

from __future__ import annotations

import asyncio
import os
import sys
from urllib.parse import urlparse

from app.settings import Settings
from app.store import open_checkpointer


def describe(url: str) -> str:
    """Host and database, never the credentials."""
    parsed = urlparse(url)
    return f"{parsed.hostname}{parsed.path}"


async def main() -> int:
    settings = Settings.from_env()
    url = os.environ.get("BRAIN_DATABASE_URL_DIRECT") or settings.database_url
    if not url:
        print("No database configured. Set BRAIN_DATABASE_URL in brain/.env.")
        return 1
    settings.database_url = url
    settings.db_setup = True
    print(f"Creating checkpoint tables on {describe(url)} ...")
    async with open_checkpointer(settings) as saver:
        # One real read proves the connection and the tables work end to end.
        await saver.aget_tuple({"configurable": {"thread_id": "init-check"}})
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
