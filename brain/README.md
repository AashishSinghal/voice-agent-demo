# Brain

The reasoning service behind the voice agent: FastAPI + LangGraph. It receives a
transcript from the Node gateway and streams back typed events. The wire format
is in [`../docs/CONTRACT.md`](../docs/CONTRACT.md); the roadmap is in
[`../PLAN.md`](../PLAN.md).

## What is here

| Module | Job |
|---|---|
| `app/graph.py` | The LangGraph: `call_model` <-> `tools`, checkpointed per thread |
| `app/context.py` | Context assembler: a strict token budget per model call, with a report of everything dropped |
| `app/cost.py` | Cost guard and degradation chain (Frontier -> Mid -> Local), step cap |
| `app/llm.py` | Provider factory (`fake`, `groq`, `ollama`) and a scripted fake model |
| `app/tools.py` | Tool registry; each tool carries a risk level |
| `app/connectors.py` | Config-driven MCP connectors, with a per-server policy |
| `app/mcp_client.py` | MCP client over stdio, written against the spec (no SDK) |
| `app/approval.py` | Spoken yes/no for risky tools, a set lookup |
| `app/stream.py` | Graph run -> contract events |
| `app/main.py` | HTTP surface |

## Run everything with one command

From the repo root:

```bash
npm install && npm run setup     # once: mprocs, backend, frontend, brain deps
npm run dev                      # brain + gateway + frontend in one terminal
```

`npm run dev` opens [mprocs](https://github.com/pvolok/mprocs): one pane per
process. Up/down picks a process, `enter` focuses its logs, `ctrl+a` returns to
the list, `r` restarts, `x` stops, `q` quits and stops everything. `chat` (the
terminal client) and `tests` are listed but not started; select one and press
`s`. Open http://localhost:5180. `backend/.env` needs `LLM_PROVIDER=brain` and a
`GROQ_API_KEY` (speech-to-text). `BRAIN_PROVIDER=groq npm run dev` switches the
brain to Groq models.

## Run the pieces separately

```bash
cd brain
uv sync
uv run pytest                                   # no network, no key

# fake model (default): deterministic, free
uv run uvicorn app.main:create_app --factory --port 8000

# local model through Ollama (tool-capable model needed)
BRAIN_PROVIDER=ollama BRAIN_LOCAL_MODEL=llama3.1:8b \
  uv run uvicorn app.main:create_app --factory --port 8000

# Groq (needs GROQ_API_KEY): frontier -> mid -> local chain
BRAIN_PROVIDER=groq uv run uvicorn app.main:create_app --factory --port 8000
```

Then point the gateway at it: `LLM_PROVIDER=brain BRAIN_URL=http://localhost:8000`.

## Connect tools

The agent's abilities come from MCP servers listed in `brain/mcp.json`; see
[`../docs/MCP.md`](../docs/MCP.md). Out of the box it has a Notes connector (save,
search, read, delete). `uv run python scripts/check_connectors.py` shows what the
model would see. Notion setup is in that document.

## Configuration

`BRAIN_PROVIDER`, `BRAIN_DB` (SQLite checkpoint file), `BRAIN_TURN_BUDGET_USD`,
`BRAIN_MAX_STEPS`, `BRAIN_CONTEXT_TOKENS`, `BRAIN_RESERVE_OUTPUT`,
`BRAIN_MCP_CONFIG`, `BRAIN_APPROVAL_TTL_S`, `BRAIN_FRONTIER_MODEL`, `BRAIN_MID_MODEL`, `BRAIN_LOCAL_MODEL`.

## Design notes

- **Tests never touch the network.** `ScriptedChatModel` is a real chat model
  that replays a script, so the whole graph, tool loops and streaming included,
  runs offline. This is also what will make the trajectory CI gate free.
- **Token counting is a deliberately high estimate** (`app/tokens.py`). A
  tokenizer would be exact but downloads vocabulary files at runtime. Trimming
  slightly early is safe; overflowing is a silent failure.
- **Trimming is never silent.** Every dropped history turn, document or tool
  schema appears in the `context` event.
- **Prices live in one table** (`app/cost.py`), matching the gateway's.
