"""OAuth for connecting a user's own account.

The state value ties the redirect back to the person who started it. It is
signed (so it cannot be forged), expires (so a stolen link is useless), and
carries the owner, so the callback needs no cookie or key of its own: the
provider sends the browser straight to the brain.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import httpx

STATE_TTL_S = 600


class OAuthError(Exception):
    pass


def _sign(key: str, body: str) -> str:
    mac = hmac.new(hashlib.sha256(f"oauth-state:{key}".encode()).digest(), body.encode(), hashlib.sha256)
    return base64.urlsafe_b64encode(mac.digest()).decode().rstrip("=")


def make_state(key: str, owner: str, service: str, now: float | None = None) -> str:
    payload = {"o": owner, "s": service, "x": int((now or time.time()) + STATE_TTL_S)}
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{body}.{_sign(key, body)}"


def read_state(key: str, state: str, service: str, now: float | None = None) -> str:
    """The owner this state was issued to; raises OAuthError if it is not valid."""
    try:
        body, sig = state.split(".", 1)
        if not hmac.compare_digest(sig, _sign(key, body)):
            raise OAuthError("bad signature")
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (ValueError, KeyError) as exc:
        raise OAuthError("malformed state") from exc
    if payload.get("s") != service:
        raise OAuthError("state is for another service")
    if payload.get("x", 0) < (now or time.time()):
        raise OAuthError("state expired")
    return payload["o"]


class NotionOAuth:
    service = "notion"

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
        auth_base: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.auth_base = auth_base
        self.transport = transport

    def authorize_url(self, state: str) -> str:
        return f"{self.auth_base}/v1/oauth/authorize?" + urlencode(
            {
                "client_id": self.client_id,
                "response_type": "code",
                "owner": "user",
                "redirect_uri": self.redirect_uri,
                "state": state,
            }
        )

    async def exchange(self, code: str) -> dict:
        """Trade the one-time code for the user's access token."""
        async with httpx.AsyncClient(timeout=15, transport=self.transport) as client:
            r = await client.post(
                f"{self.auth_base}/v1/oauth/token",
                json={"grant_type": "authorization_code", "code": code, "redirect_uri": self.redirect_uri},
                auth=(self.client_id, self.client_secret),
            )
        if r.status_code != 200:
            raise OAuthError(f"token exchange failed ({r.status_code})")
        return r.json()
