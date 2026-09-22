# Voice Agent Demo

A streaming, interruptible voice agent for customer support. Speech in, speech
out, over a WebSocket — with sentence-level streaming so the caller hears the
first sentence while the model is still writing the rest, and barge-in so they
can talk over the agent.

```
mic ──> VAD ──> Whisper (Groq) ──> LLM (Groq or Ollama, streaming)
                                        │
                                        ├─ sentence 1 ──> TTS ──> audio chunk ──> speaker
                                        ├─ sentence 2 ──> TTS ──> audio chunk ──> speaker
                                        └─ ...
```

Talking while the agent speaks aborts the in-flight LLM stream and kills the
running TTS process mid-sentence.

## Running locally

### 1. Get a Groq API key (free, ~2 minutes)

1. Go to **https://console.groq.com** and sign in with Google or GitHub.
2. Open **API Keys** → **Create API Key**, name it anything, copy the value.
3. You only see it once — paste it somewhere before closing the dialog.

No credit card, no billing setup. The free tier covers this comfortably:
8 hours/day of Whisper transcription and 1,000 LLM requests/day.

This one key covers both speech-to-text and the LLM.

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env          # then paste your key into GROQ_API_KEY
npm run dev
```

Check it came up:

```bash
curl -s localhost:3000/health
```

`"groq": "configured"` means the key was picked up. If it says
`missing (set GROQ_API_KEY)`, the placeholder is still in `.env`.

### 3. Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173, click **Start Call**, and allow microphone access.
The browser will only grant the mic on `localhost` or over HTTPS.

### 4. Try it

- *"Where is my money?"* — answered from the FAQ knowledge base
- *"What are your fees?"* — out of scope, transfers to a human
- **Start talking while the agent is speaking** — it stops mid-sentence

The purple panel reports per-turn latency: time to first token, time to first
audio, and total response time.

## Configuration

Everything is provider-pluggable so the same code runs locally and deployed.

| Variable | Options | Default | Notes |
|---|---|---|---|
| `LLM_PROVIDER` | `groq`, `ollama` | `groq` | `groq` needs no local model. `ollama` is fully offline but needs Ollama running and `ollama pull phi3`. |
| `GROQ_MODEL` | any free chat model | `openai/gpt-oss-20b` | Groq dropped Llama from the free tier in 2026. [Current list](https://console.groq.com/docs/models). |
| `TTS_PROVIDER` | `say`, `piper` | `piper` | `.env.example` sets `say` for local dev — see below. |
| `SAY_VOICE` | any macOS voice | `Samantha` | `say -v '?'` lists them. |

### Why `say` locally and Piper in deployment

The `piper-tts` macOS arm64 wheel (1.8.0) ships an espeak-ng data path pointing
at its own CI build machine, so it cannot synthesise anything on a Mac —
`initialize()` is given the correct bundled directory and the native bridge
ignores it. The Linux wheel used in the container is unaffected.

So local development uses macOS's built-in `say` (zero setup, no 60 MB model
download), and deployment uses Piper. The provider is a single env var; the
call site in `ttsService.ts` is identical either way.

To run fully offline on a Mac you would need a working Piper — otherwise use
`LLM_PROVIDER=ollama` with `TTS_PROVIDER=say`, which keeps the LLM local.

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) — a $0/month setup on Render + Vercel + Groq.

## Layout

```
backend/src/
  server.ts                  socket pipeline, turn state, barge-in handling
  services/llmService.ts     streaming LLM, provider-agnostic, cancellable
  services/ttsService.ts     TTS, provider-agnostic, cancellable
  services/sentenceChunker.ts  token stream -> speakable sentences
  services/whisperService.ts   Groq Whisper STT
  services/audioProcessor.ts   ffmpeg webm -> 16 kHz mono wav
frontend/src/
  hooks/useMicStream.ts               one mic stream per call
  hooks/useVoiceActivityDetection.ts  speech start (barge-in) + speech end
  hooks/useAudioPlayback.ts           ordered chunk queue with stop()
  hooks/useSocketConnection.ts        streaming events
  hooks/useAudioRecorder.ts           records from the shared stream
```

## Requirements

- Node 20+
- `ffmpeg` on PATH (`brew install ffmpeg`)
- macOS for `TTS_PROVIDER=say`; any platform for `piper`
