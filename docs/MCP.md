# Connecting tools with MCP

The brain gets every capability beyond conversation from [MCP](https://modelcontextprotocol.io)
servers. Adding one is a config change: no code, no redeploy. This page covers
how to connect one, what the brain does to keep that safe, and how the protocol
layer is built.

## Connect a server

Copy `brain/mcp.example.json` to `brain/mcp.json` (gitignored). The shape is the
`mcpServers` convention other MCP clients use, so an existing config pastes in.

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": { "NOTION_TOKEN": "${NOTION_TOKEN}" },
      "startupTimeoutSeconds": 60,
      "policy": {
        "allow": ["API-post-search", "API-retrieve-a-page", "API-post-page"],
        "safe": ["API-post-search"]
      }
    }
  }
}
```

Secrets stay out of the file: `${VAR}` is filled from the environment or
`brain/.env`. With no `mcp.json`, the built-in Notes connector is used.

Then check it, before talking to anything:

```bash
cd brain && uv run python scripts/check_connectors.py
```

It starts every connector and prints what the model would see: which tools
survived policy, the risk assigned to each, and what the schemas cost in
context. It calls no tools.

### Notion, step by step

1. Create an **internal integration** in your Notion workspace's integration
   settings and copy its secret (it starts with `ntn_`).
2. **Share the pages or databases** you want reachable with that integration
   (a page's Connections menu). An integration sees nothing it was not given.
3. Put `NOTION_TOKEN=ntn_...` in `brain/.env`.
4. `cp brain/mcp.example.json brain/mcp.json`, then run `check_connectors`.
5. Restart the brain.

This uses Notion's open-source stdio server. Notion also runs a hosted server
at `https://mcp.notion.com/mcp` that uses OAuth; it needs the Streamable HTTP
transport, which the brain does not speak yet (see Limits).

## What keeps a third-party server in check

A server is someone else's code that the model can drive, so the brain enforces
policy at its own boundary and never relies on the model behaving.

| Control | Where | Effect |
|---|---|---|
| **Scopes** (built-in servers) | `MCP_GRANTED_SCOPES` | Tools outside the grant are not listed, and a direct call is refused with `-32001` |
| **`policy.allow` / `deny` / `readOnly`** | brain, per connector | A tool the policy hides never reaches the model |
| **Risk from annotations** | brain | Read-only tools run at once; destructive or open-world tools, and tools with no annotations at all, need a spoken yes |
| **`policy.safe`** | brain, per connector | The user vouches for a specific tool (a search that is a POST) |
| **Clean environment** | brain | A spawned server gets `PATH`, `HOME` and what its config names, never `GROQ_API_KEY` |
| **Namespacing** | brain | Third-party tools are exposed as `server__tool`, so two servers cannot collide |
| **Fail-soft startup** | brain | A connector that fails to start is reported on `/health` and skipped |
| **Tool output is data** | system prompt | Text a tool returns is never to be followed as instructions |

Risk follows the spec's own defaults: a tool that is not read-only is assumed
destructive and open-world unless the server says otherwise, so a server must
opt in to being safe.

### Context is a budget too

Notion's server exposes 24 tools whose schemas cost about 6,450 tokens, more
than a 6,000-token window before a word of conversation. Connecting a large
server without `policy.allow` crowds out the conversation; `check_connectors`
warns above 35%. The assembler reports any schema it has to drop.

## Approval

A tool whose risk is `confirm` pauses the graph instead of running.

1. The brain streams its question as ordinary tokens ("I'm about to delete the
   note "groceries". Should I go ahead?"), so the gateway speaks it with no
   special case, followed by an `approval_required` event.
2. The graph is checkpointed in SQLite. The question survives a restart.
3. The caller's next utterance answers it, decided by a **set lookup, not a
   model call** (`app/approval.py`). Only an unambiguous yes approves. A no
   anywhere wins ("yes... no wait" declines). Anything else declines silently
   and is handled as a new request. An approval older than
   `BRAIN_APPROVAL_TTL_S` (600) is not honoured.
4. Declining ends the turn with no further model call.

Two properties are tested rather than assumed. LangGraph re-runs an interrupted
node from the top on resume, so the approval gate has no side effects and
execution happens in a separate node: a safe tool called alongside a risky one
runs exactly once. And each risky call is asked about separately: one yes never
approves a second action.

## The protocol layer

There is no MCP SDK anywhere. The protocol is JSON-RPC 2.0 over newline-delimited
stdio, small enough to own.

- **Server** (`mcp/jsonrpc_server.py`, standard library only): `initialize`
  with version negotiation, `ping`, `tools/list`, `tools/call`, the JSON-RPC
  error codes, argument validation. `handle()` is pure, so the whole protocol
  is tested without a subprocess. Notifications never get a response, batching
  is rejected (removed from the spec), a handler crash returns an error result
  and keeps the server alive.
- **Client** (`brain/app/mcp_client.py`): async subprocess, requests matched to
  responses by id so calls are concurrent, per-request timeouts, and a server
  that dies fails every outstanding request immediately instead of hanging a
  call.
- **Independence check**: the client is also tested against
  `tests/fixtures/rogue_server.py`, a server written separately, that has no
  annotations, hangs, dies mid-call, returns a prompt injection and reports
  whether it can see the brain's secrets.

## Limits

- **stdio only.** No Streamable HTTP and no OAuth, so hosted servers
  (`mcp.notion.com`, most SaaS connectors) cannot be connected yet. That is the
  next transport to add.
- Tools only: no resources, prompts or sampling.
- Connectors start with the brain; adding one needs a restart.
- Policy on third-party servers is enforced by the brain, not the server, so it
  is only as good as the tool names and annotations the server reports.
