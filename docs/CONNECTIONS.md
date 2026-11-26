# Connecting a user's own accounts

A visitor can connect their own Notion, and the agent can then search their pages
and add notes. The same shape carries any other service that offers OAuth.

## How it works

```
page ──socket──▶ gateway ──HTTP + key──▶ brain ──▶ provider (Notion)
  ▲                                         │
  └── popup: provider sign-in ──redirect────┘  (signed `state`, no key needed)
```

- **Owner.** The browser keeps a random secret (`va-owner-key`, localStorage) and
  sends it in the socket handshake. The gateway hashes it to an *owner id*; the
  brain only ever sees the hash. The secret is not in the resume link, so sharing
  a conversation link does not share someone's accounts.
- **State.** `/v1/owners/{owner}/connections/{service}/start` returns the
  provider's sign-in URL with a signed, 10-minute `state` naming the owner. The
  provider redirects the popup to `/oauth/{service}/callback`, which checks the
  signature and stores the token for that owner.
- **Storage.** Tokens are encrypted (Fernet, `BRAIN_TOKEN_KEY`) before they reach
  the database (LangGraph store, same SQLite file or Postgres as the
  checkpoints). Rotating the key disconnects everyone; they reconnect.
- **Tools.** `ToolSet.for_owner(owner)` adds that owner's tools to the shared
  ones on each model call (`app/notion.py`). Reads run at once; adding a note
  pauses for a spoken yes like any risky tool. The model never sees the token.

## Turn it on

Brain environment:

| Variable | Meaning |
|---|---|
| `BRAIN_TOKEN_KEY` | Fernet key. `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `BRAIN_PUBLIC_URL` | Where the brain is reachable by the user's browser; the redirect URI is `<this>/oauth/notion/callback` |
| `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | From a *public* integration at notion.so/my-integrations |

Without `BRAIN_TOKEN_KEY` and the Notion pair, the panel shows nothing.

In Notion, the public integration needs the redirect URI above registered. A user
only exposes the pages they pick on Notion's consent screen, so "nothing found"
usually means the page was not shared.

## Try it without Notion

```bash
cd brain && uv run python scripts/fake_notion.py        # a stand-in on :9100
```

Run the brain with `NOTION_CLIENT_ID=fake NOTION_CLIENT_SECRET=fake
NOTION_AUTH_BASE=http://localhost:9100 NOTION_API_BASE=http://localhost:9100`
plus a `BRAIN_TOKEN_KEY`, then use "Connected accounts" in the debug panel.

## Limits

- No login: the owner secret is the identity. Clearing site data means
  reconnecting; anyone who copies the secret out of the browser acts as that user.
- One connection per service per owner; Notion access tokens do not expire, so
  there is no refresh flow yet. Other providers will need one.
- Every visitor's calls still count against the shared Groq quota and per-IP limits.
