# Plan: from voice demo to an agent that does things

The voice loop (interruptions, truthful history, per-turn cost) is done and is
the project's differentiator. This plan adds what makes an agent useful and
trustworthy when it touches real systems: reasoning, memory, tools, spend
control and evidence that it behaves.

**The story:** a personal operations agent you talk to. It triages each request,
remembers you, acts through MCP connectors, asks before doing anything
irreversible, and cannot spend more than a set budget. Each item below is one
layer of that story, not a standalone demo.

**Constraint:** nothing here may require paid infrastructure to build or test.
Groq free tier and local Ollama for models, SQLite for state, recorded fixtures
for anything that would otherwise burn model calls in CI.

## Architecture

```
gateway/   Node. Voice, sockets, VAD, interruptions, STT/TTS, sentence chunker.
           (today still at backend/, moved after the hardening PR merges)
brain/     Python. FastAPI + LangGraph. Router, context assembler, memory,
           RAG, PII proxy, cost guard, MCP client.
mcp/       Raw JSON-RPC 2.0 servers (no SDK): notes, calendar, github.
evals/     Golden trajectories and the CI gate.
docs/      ADRs and teardowns.
```

The gateway keeps everything latency-critical. It sends the brain a transcript
and receives a stream of typed events; it never knows which model or graph runs
behind it (`docs/CONTRACT.md`). The existing Node LLM path stays as a fallback
(`LLM_PROVIDER=groq|ollama`), and the brain is a third provider (`brain`).

Decisions worth an ADR as we go: hybrid Node+Python over a rewrite; LangGraph
over Temporal; raw JSON-RPC MCP over the SDK; heuristic token counting over a
tokenizer download.

## Phases

### 0. Hardening (separate PR, in progress)
Log redaction, per-session logs, per-IP and daily caps, payload validation,
temp-path and config cleanup.

### 1. Foundation (this branch: `feat/brain-foundation`)
- **Brain service skeleton.** FastAPI, SSE streaming, `uv`-managed, tests run
  with no network.
- **Gateway-to-brain contract.** One streaming endpoint with typed events
  (`token`, `tool_call`, `tool_result`, `approval_required`, `usage`, `done`,
  `error`). Specified in `docs/CONTRACT.md`, mirrored by pydantic models.
- **LangGraph core.** `assemble_context -> call_model -> (tools -> call_model)*`
  with a SQLite checkpointer so a thread survives a restart and reconnects.
- **#1 Context assembler.** Per-request token budget across system prompt, tool
  schemas, working memory and retrieved documents. Each section has a priority
  and a minimum; overflow trims lowest priority first and the dropped content
  is reported in the response, so context loss is never silent.
- **#11 Cost guard and degradation chain.** Projects spend before each model
  call; halts the loop when the projected total passes the cap (default $0.50);
  steps down Frontier -> Mid -> Local -> Cache rather than failing outright.
- **Provider abstraction.** `fake` (deterministic, used by tests and CI),
  `groq`, `ollama`.
- **Gateway client.** `brain` provider in the Node gateway that consumes the
  event stream.

Done when: a spoken turn can be routed through the brain end to end, a thread
resumes after a process restart, and a runaway loop is stopped by the guard in
a test.

### 2. Hands
- **#3 Raw MCP client and servers.** JSON-RPC 2.0 over stdio and HTTP, written
  against the spec. Capability scoping: each tool carries a scope, each session
  a token listing the scopes it may use. Connectors (notes, calendar, github)
  ship as MCP servers, mocked first.
- **#2 Durable approvals.** Tools marked `confirm` pause the graph with
  `interrupt()`. Approval arrives by voice ("yes, send it"), the UI, or a Slack
  webhook; the thread survives a crash while waiting. Retries use exponential
  backoff with jitter and a retry budget.
- **#14 PII proxy.** Identifiers are swapped for stable tokens before any model
  call and restored after, with an audit log of what was swapped. Lightweight
  detectors only (no heavy NLP on the 0.1 vCPU box).

### 3. Knowledge
- **#5 Self-correcting agentic RAG.** retrieve -> grade -> rewrite query ->
  retry (bounded) -> answer or abstain. Abstention is a first-class outcome
  spoken plainly ("I don't have that in your documents").
- **#6 Three-tier memory.** Scratchpad (this turn), episodic summaries (per
  session), semantic store (vector search). Importance scoring on write and
  scheduled eviction. Embeddings are hosted or local-Ollama, never computed on
  the free instance.

### 4. Economics
- **#4 Triage router.** A small model returns a typed decision (`answer`,
  `retrieve`, `tool`, `escalate`); only escalations reach the heavy model.
  The routing ratio and cost per turn are measured, not assumed.
- **Degradation chain** wired to the router's tiers.
- **#12 Shadow routing.** Replay a sample of traffic against a candidate model
  or prompt off the live path; diff trajectory, cost and latency.

### 5. Trust
- **#7 Trajectory CI gate.** Golden tool-call sequences per scenario, run
  against recorded model outputs (deterministic and free) in a GitHub Action.
  A PR fails when the sequence deviates, with a diff of where.
- **#8 Inter-agent sanitization.** A reader agent sees untrusted content, an
  actor agent holds the dangerous tools, and a proxy between them enforces
  least privilege and strips instructions from data. Demonstrated with a
  prompt-injection scenario in the golden set.

### 6. Polish
- **#10 Feedback flywheel.** Thumbs-down capture, preference-pair dataset
  export, and a notebook for a manual LoRA run. A nightly automated fine-tune is
  out of scope: it needs paid GPU time, and the repo will say so.
- **#15 Teardowns.** Three published write-ups with diagrams, measured
  cost/latency and ADRs: the interruption loop, the cost and routing economics,
  and the safety layer (approvals, PII, sanitization).
- **#13 Computer-use fallback.** Optional and local-only, against a mock legacy
  portal. Headless browsers do not fit the free-tier box.
- Demo recording of an interruption and a confirmed action.

## Out of scope, deliberately
- Temporal (LangGraph checkpointing covers the durability story with less to
  operate).
- Automated nightly fine-tuning (cost).
- Horizontal scaling of the gateway.

## Measuring success
Every claim in the write-ups must be a number from this repo: first-audio
latency through the brain vs the direct path, routing ratio and cost per
thousand turns, golden-set pass rate, abstention precision on an RAG eval set,
and the injection scenarios blocked.
