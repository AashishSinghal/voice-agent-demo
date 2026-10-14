# Gateway <-> brain contract

The Node gateway owns audio, interruptions and latency. The Python brain owns
reasoning. They meet at three HTTP endpoints. The gateway never learns which
model, graph or tool ran; it learns only what happened.

Selected with `LLM_PROVIDER=brain` and `BRAIN_URL` (default
`http://localhost:8000`). Any other provider bypasses the brain entirely.

## `POST /v1/turn` — one caller utterance, streamed back

Request:

```json
{ "session_id": "socket-id", "text": "what is 17 plus 25" }
```

`session_id` is the LangGraph thread id. The brain keeps the conversation, so
the gateway sends only the new utterance, never the history.

Response: Server-Sent Events, one JSON object per `data:` line, framed `\r\n`.
Every stream ends with exactly one `done` or `error`.

| `type` | Fields | Meaning |
|---|---|---|
| `context` | `report` | What the context assembler kept and dropped for this model call |
| `token` | `text` | Streamed reply text. This is what the voice loop speaks |
| `tool_call` | `id`, `name`, `args` | The model asked for a tool |
| `tool_result` | `id`, `name`, `content` | The tool's output |
| `usage` | `tier`, `model`, `prompt_tokens`, `completion_tokens`, `usd`, `turn_usd`, `degraded_from` | One model call's cost |
| `done` | `text`, `turn_usd`, `steps`, `degraded` | Terminal. `degraded` means the cost guard intervened |
| `error` | `message` | Terminal |

Unknown event types must be ignored, so the brain can add events without a
gateway release. A turn can contain several `context`/`usage` pairs: one per
model call in a tool loop.

If the gateway aborts the request (the caller interrupted), the brain cancels
generation. The thread then ends on the caller's message, not on a reply.

## `POST /v1/threads/{session_id}/heard` — what the caller actually heard

```json
{ "spoken": "Sure, the first step", "unspoken": "is to open the file." }
```

Sent after an interruption. The repo's central rule is that history records
only what was heard, and the brain keeps its own checkpointed history, so it
must be told. Behaviour:

- last message is a finished reply: it is rewritten to `spoken`, flagged
  interrupted, with `unspoken` retained so "go back to that" works;
- last message is anything else (the reply was cut off before the graph saved
  it): `spoken` is appended as the reply, so the previous turn's answer is not
  overwritten;
- `spoken` empty: the reply is removed.

The gateway fires this without blocking the interruption path; its client makes
the next `/v1/turn` for the same session wait for it.

## `GET /v1/threads/{session_id}`

`{ "sessionId", "messages", "sessionUsd" }`. Introspection and tests.

## `GET /health`

Provider, active tiers and the per-turn budget.

## Cost and degradation

Each turn has a budget (`BRAIN_TURN_BUDGET_USD`, default $0.50) and a step cap
(`BRAIN_MAX_STEPS`, default 6). Before every model call the guard projects the
cost and steps down Frontier -> Mid -> Local, or halts a runaway loop. A
degraded turn still returns a spoken reply and `done.degraded = true`.
