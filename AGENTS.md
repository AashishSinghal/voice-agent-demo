# Voice Agent — Project Directives

An interruptible, general-purpose voice agent: speech in, speech out, over a
Socket.IO WebSocket. A React frontend captures the microphone and plays audio;
a Node backend runs Groq Whisper (STT), a streaming LLM, and TTS, and decides
whether the caller meant to interrupt. It is a portfolio demo (featured as a
case study on aashishsinghal.com), live at
https://voice-agent-demo-drab.vercel.app and running at $0/month on Render +
Vercel + Groq. The premise: conversation quality comes from the infrastructure
around the model, so everything must hold up with a small, cheap model.

## Prime directives

- **Reaction latency is the product.** Anything on the path between the caller
  speaking and the agent reacting must stay fast and predictable. Check changes
  against the latency budget in `README.md`. If decision time is consistently
  over ~1.2s, cut the endpointing window first, not the model.
- **Backchannel classification is a set lookup, not a model call.** It sits on
  the critical path (`backend/src/services/backchannel.ts`). Do not replace it
  with an LLM call.
- **History records only what was heard.** On interruption, only sentences that
  finished playing go into history (flagged as interrupted); the unsaid
  remainder is kept so "go back" works (`services/conversation.ts`).
- **The deployed box does no signal processing.** The free instance has
  0.1 vCPU. TTS is hosted (`TTS_PROVIDER=groq`) and audio is never transcoded:
  Whisper takes webm directly, so a clip is forwarded untouched or remuxed with
  a stream copy (`services/audioProcessor.ts`). Do not add CPU work to the
  request path.
- **Providers stay pluggable.** LLM (`groq`/`ollama`) and TTS (`say`/`groq`/
  `piper`) are selected by env var; call sites must not care which is active.
- **Stay inside the free tier.** Groq free quota is ~1,000 requests/day, and a
  turn costs roughly five (one STT, one LLM, one TTS per sentence).

## Architecture

```
backend/src/
  server.ts                    socket protocol, call state, interruption triage, watchdog
  services/conversation.ts     history; truncation to what was actually heard
  services/backchannel.ts      "mhm" vs a real interruption; Whisper silence artefacts
  services/sentenceChunker.ts  token stream -> speakable sentences
  services/llmService.ts       streaming LLM, provider-agnostic, cancellable
  services/ttsService.ts       TTS, provider-agnostic, cancellable
  services/whisperService.ts   Groq Whisper STT
  services/audioProcessor.ts   trims to the speech onset; never transcodes
  services/timeline.ts         per-stage turn timings
  services/logBridge.ts        mirrors console output to the client diagnostic log
  smoke.ts                     tests
backend/scripts/               fetch-voice.sh (Piper model), check-memory.sh
backend/Dockerfile             two-stage image; Piper only with INSTALL_PIPER=true
frontend/src/
  components/VoiceAgent/       VoiceAgent.tsx (call loop + timing constants), Orb,
                               Transcript, DebugPanel, Attribution
  hooks/                       useMicStream, useVoiceActivityDetection,
                               useAudioRecorder, useAudioPlayback, useSocketConnection
  stores/useBotStateStore.ts   zustand: call state, timeline, benchmarks
  lib/diagnostics.ts           exportable session log
render.yaml                    Render Blueprint for the backend
frontend/vercel.json           Vercel config (root directory: frontend)
```

Turn flow: the mic records for the whole call; the adaptive noise gate marks a
speech onset; the server trims to 700ms before it, transcribes, streams the LLM,
chunks by sentence, and synthesises each sentence while later ones are still
generating. On barge-in the client pauses playback locally (~250ms) and sends
`barge:detected`; after the utterance the server either emits
`playback:resume` (backchannel) or `turn:interrupted`.

## Commands

Backend (`cd backend`): `npm run dev` (nodemon + tsx, port 3000), `npm test`
(same as `npm run smoke`, runs `src/smoke.ts`), `npm run build` (tsc to
`dist/`), `npm start`, `npm run fetch-voice [-- <voice>]`.
Health check: `curl -s localhost:3000/health` should report
`"groqKey": "configured"`.

Frontend (`cd frontend`): `npm run dev` (Vite, http://localhost:5173),
`npm run build` (`tsc -b && vite build`), `npm run lint` (eslint),
`npm run preview`.

Docker (memory check for the Piper build):
`docker build --platform linux/amd64 --build-arg INSTALL_PIPER=true -t voice-agent .`
then `./scripts/check-memory.sh voice-agent 512m`.

Deploy: backend via Render Blueprint (`render.yaml`, `backend/Dockerfile`);
frontend via Vercel with Root Directory `frontend`. Full steps in
`DEPLOYMENT.md`.

Requirements: Node 20+, `ffmpeg` on PATH, macOS for `TTS_PROVIDER=say`.

## Configuration

Names only; see `backend/.env.example` for defaults and comments. Never commit
`.env`.

- Backend: `PORT`, `NODE_ENV`, `CLIENT_URL` (CORS origin), `LLM_PROVIDER`,
  `GROQ_API_KEY`, `GROQ_MODEL`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `TTS_PROVIDER`,
  `SAY_VOICE`, `GROQ_TTS_MODEL`, `GROQ_TTS_VOICE`, `PIPER_MODEL`,
  `PIPER_MODEL_PATH`, `PIPER_BIN`, `AGENT_PERSONA`, `AGENT_GREETING`.
- Frontend: `VITE_SERVER_URL` (backend URL; defaults to `http://localhost:3000`).
- `.env.example` sets `TTS_PROVIDER=say` for local Mac dev; code and deployment
  default to `groq`.

## Conventions

- TypeScript throughout; backend is ESM (`"type": "module"`), frontend is
  React 19 + Vite + Tailwind 4 with shadcn-style primitives in `components/ui/`.
- Timing constants live as named `*_MS` constants with a comment explaining the
  number (`frontend/src/components/VoiceAgent/VoiceAgent.tsx`,
  `backend/src/server.ts`). Keep that pattern.
- Commit messages: imperative, sentence-case subject describing the behaviour
  change ("Stop the watchdog cutting off long answers"), with a body that
  explains the observed symptom, the cause, and the fix.
- Lockfiles are committed on purpose (`npm ci` in the Docker build needs them).
- The Piper voice model (~63MB) is never committed; fetch it with
  `npm run fetch-voice`.

## Gotchas and hard-won lessons

- **Watchdog vs long answers.** Busy states that stop progressing are recovered
  by a watchdog (`STUCK_TIMEOUT_MS` 20s, `SPEAKING_STUCK_TIMEOUT_MS` 45s). The
  client must heartbeat `playback:progress` every 4s while audio plays
  (`PLAYBACK_HEARTBEAT_MS`); without it a long reply looks like a stall and gets
  cut off mid-sentence.
- **MediaRecorder leaks.** `onstop` is async. Clear the recorder ref only if it
  still points at that recorder, and snapshot everything a send depends on
  (barge flag, discard intent) at stop time. Getting this wrong orphaned
  recorders and sent near-silent buffers.
- **Record continuously.** Starting the recorder on VAD confirmation lost the
  first words ("explain software engineering" -> "engineering"). Idle recycling
  (`IDLE_RECYCLE_MS`) must only fire during genuine quiet.
- **Whisper hallucinates on silence** ("Thank you.", "Thanks for watching!").
  Guards: client drops clips with under 300ms of audible speech
  (`MIN_SPOKEN_MS`), server rejects known artefacts on short clips.
- **Empty interruptions.** A barge that turns out to be silence must resume via
  `barge:cancelled`, or the call stays paused forever.
- **Paused playback must always be released** when the server hands control
  back; a missed resume used to mute the rest of a call.
- **Piper vs hosted TTS.** On Render free, Piper took ~29s per sentence and an
  ffmpeg transcode ~5.2s; one turn took 104s. Memory was fine (57MB idle of
  512MB); CPU was the constraint. Piper stays behind
  `--build-arg INSTALL_PIPER=true` for a paid instance. `piper-tts` 1.8.0 cannot
  synthesise on macOS arm64 at all, hence `say` locally.
- **Groq Orpheus terms.** TTS returns a 400 `model_terms_required` until an org
  admin accepts the model terms in the Groq playground (DEPLOYMENT.md step 0).
- **CORS.** `CLIENT_URL` on Render must match the Vercel URL, or the socket
  silently connects to nothing.
- **Cold starts.** Render free sleeps after 15 minutes (30-50s wake). An
  UptimeRobot ping on `/health` every 5 minutes keeps it warm and fits the 750
  free hours for exactly one service.
- **Build for amd64.** An arm64 image built on a Mac will not start on Render.
- Every `console.*` line is bridged to the client diagnostic log
  (`logBridge.ts`); a subscriber that logs must not recurse. In dev,
  `__diag.toText()` and `__botStore` are on `window`.
- **Stale docs:** the README section "Why `say` locally and Piper in deployment"
  and `backend/README.md` still say Piper is used in deployment. Deployment uses
  `TTS_PROVIDER=groq`; `DEPLOYMENT.md` and `render.yaml` are current.

## Current state and next steps

Deployed and working. Known limitations (README): single instance, in-memory
per-socket conversation state, and reaction time floored by endpointing plus
transcription. Ideas already written down in the repo, not implemented:
speculative resume after a backchannel (README), and per-IP turn caps plus a
daily counter to protect the Groq quota (DEPLOYMENT.md). No TODOs in code.
Tests cover truncation, turn salvage, backchannel classification, the silence
filter and the log bridge; there are no frontend tests.
