"""Where conversation state lives.

SQLite for local work: a file, no setup. Hosted Postgres in the cloud, because a
serverless function has no durable disk and consecutive requests can land on
different instances; the checkpoint has to live somewhere they all can reach.

Behind a connection pooler (Neon and Supabase both put one in front) the saver
must not hold a single long-lived connection, and server-side prepared
statements break in transaction pooling mode. So it gets a small pool with
prepared statements off, and connections are checked before use because a pooler
or firewall may have dropped one while the instance was idle.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver

from .settings import Settings


def pool_kwargs() -> dict[str, Any]:
    """Per-connection settings a pooled Postgres checkpointer needs."""
    from psycopg.rows import dict_row

    return {"autocommit": True, "prepare_threshold": None, "row_factory": dict_row}


@asynccontextmanager
async def open_checkpointer(settings: Settings) -> AsyncIterator[BaseCheckpointSaver]:
    if settings.database_url:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
        from psycopg_pool import AsyncConnectionPool

        pool = AsyncConnectionPool(
            conninfo=settings.database_url,
            min_size=0,  # nothing to hold open while the function is idle
            max_size=settings.db_pool_size,
            kwargs=pool_kwargs(),
            check=AsyncConnectionPool.check_connection,
            open=False,
        )
        await pool.open()
        try:
            saver = AsyncPostgresSaver(pool)
            if settings.db_setup:
                await saver.setup()
            yield saver
        finally:
            await pool.close()
        return

    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    if settings.db_path != ":memory:":
        Path(settings.db_path).parent.mkdir(parents=True, exist_ok=True)
    async with AsyncSqliteSaver.from_conn_string(settings.db_path) as saver:
        yield saver
