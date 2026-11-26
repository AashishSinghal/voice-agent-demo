"""Who has connected which account, and the secrets that let us act for them.

A connection is an access token a user granted us for a service (Notion). The
token is encrypted with BRAIN_TOKEN_KEY before it touches the database, so a
leaked backup or a read-only database user gets ciphertext. An *owner* is an
opaque id the gateway derives from a secret held in the user's browser; it is
not a login, and nothing here ever shows a token to a model or a client.
"""

from __future__ import annotations

import json
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from langgraph.store.base import BaseStore

NAMESPACE = "connections"


class Connections:
    def __init__(self, store: BaseStore, token_key: str | None) -> None:
        self._store = store
        self._fernet = Fernet(token_key.encode()) if token_key else None

    @property
    def enabled(self) -> bool:
        return self._fernet is not None

    def _ns(self, owner: str) -> tuple[str, str]:
        return (NAMESPACE, owner)

    async def save(self, owner: str, service: str, secret: dict[str, Any], meta: dict[str, Any]) -> None:
        assert self._fernet is not None
        sealed = self._fernet.encrypt(json.dumps(secret).encode()).decode()
        await self._store.aput(self._ns(owner), service, {"sealed": sealed, "meta": meta})

    async def secret(self, owner: str, service: str) -> dict[str, Any] | None:
        """The stored secret, or None if absent or no longer decryptable."""
        if self._fernet is None:
            return None
        item = await self._store.aget(self._ns(owner), service)
        if item is None:
            return None
        try:
            return json.loads(self._fernet.decrypt(item.value["sealed"].encode()))
        except InvalidToken:
            return None  # the key was rotated; treat as not connected

    async def listing(self, owner: str) -> list[dict[str, Any]]:
        """What is connected, without any secret."""
        items = await self._store.asearch(self._ns(owner), limit=50)
        return [{"service": i.key, **i.value["meta"]} for i in items]

    async def remove(self, owner: str, service: str) -> None:
        await self._store.adelete(self._ns(owner), service)
