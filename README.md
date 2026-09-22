# Voice Agent

A general-purpose, interruptible voice agent. Speech in, speech out, over a
WebSocket.

The design goal is that **the conversation holds up even when the model is
weak**. Almost everything that makes this feel responsive lives in the
infrastructure around the model, not in the model itself.

```
mic ──> VAD ──> Whisper (Groq) ──> LLM (Groq or Ollama, streaming)
                                        │
                                        ├─ sentence 1 ──> TTS ──> audio chunk ──> speaker
                                        ├─ sentence 2 ──> TTS ──> audio chunk ──> speaker
                                        └─ ...
```

## What the infrastructure does

**Streams by sentence.** Audio for sentence one is synthesised and playing while
the model is still writing sentence three, so the caller hears a reply almost
immediately rather than after the full response.

**Tells a backchannel from an interruption.** Saying "mhm" or "yeah" while the
agent talks does not stop it — playback pauses, the utterance is transcribed and
classified, and if it was only an acknowledgement playback resumes from exactly
where it stopped. A real question stops the agent immediately.

**Keeps history honest about what was heard.** When the caller does interrupt,
the agent has usually generated more than it managed to say. Only the sentences
that actually finished playing go into the conversation history, flagged as
interrupted — so the model never refers back to something the caller never
heard. The unsaid remainder is kept separately, so "go on" can pick up where it
left off.

**Fails softly.** Per-stage timeouts mean a hung transcription cannot wedge the
call; the turn is abandoned and the agent goes back to listening.

None of this requires a capable model. Swap in a small local one and the
conversation still behaves.

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

- Ask it anything — it is a general assistant by default.
- **Say "mhm" while it talks** — it keeps going.
- **Ask a real question while it talks** — it stops mid-sentence.
- **Then say "go on"** — it resumes from what it never got to say.

Open **debug** (top right) for live call state, per-stage latency, and the
event log showing each interruption being classified.

## Configuration

Everything is provider-pluggable so the same code runs locally and deployed.

| Variable | Options | Default | Notes |
|---|---|---|---|
| `LLM_PROVIDER` | `groq`, `ollama` | `groq` | `groq` needs no local model. `ollama` is fully offline but needs Ollama running and `ollama pull phi3`. |
| `GROQ_MODEL` | any free chat model | `openai/gpt-oss-20b` | Groq dropped Llama from the free tier in 2026. [Current list](https://console.groq.com/docs/models). |
| `TTS_PROVIDER` | `say`, `piper` | `piper` | `.env.example` sets `say` for local dev — see below. |
| `SAY_VOICE` | any macOS voice | `Samantha` | `say -v '?'` lists them. |
| `AGENT_PERSONA` | any prompt | general assistant | Repurpose the agent without touching code. |
| `AGENT_GREETING` | any text | "Hey, I'm listening…" | First thing it says. |

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
  server.ts                    socket protocol, call state, interruption triage
  services/conversation.ts     history; truncation to what was actually heard
  services/backchannel.ts      "mhm" vs a real interruption
  services/sentenceChunker.ts  token stream -> speakable sentences
  services/llmService.ts       streaming LLM, provider-agnostic, cancellable
  services/ttsService.ts       TTS, provider-agnostic, cancellable
  services/whisperService.ts   Groq Whisper STT
  services/audioProcessor.ts   ffmpeg webm -> 16 kHz mono wav
  smoke.ts                     tests for truncation + classification
frontend/src/
  components/VoiceAgent/Orb.tsx         state-coloured, level-reactive orb
  components/VoiceAgent/DebugPanel.tsx  state, latency, event log
  hooks/useMicStream.ts                 one mic stream per call
  hooks/useVoiceActivityDetection.ts    speech start (barge-in) + speech end
  hooks/useAudioPlayback.ts             queue with pause/resume/stop
  hooks/useSocketConnection.ts          streaming protocol
  hooks/useAudioRecorder.ts             records from the shared stream
```

## Tests

```bash
cd backend && npm test
```

Covers the two pieces where a bug would be invisible in a demo but wrong in
conversation: history truncation after an interruption, and backchannel
classification.

## Requirements

- Node 20+
- `ffmpeg` on PATH (`brew install ffmpeg`)
- macOS for `TTS_PROVIDER=say`; any platform for `piper`
