# Backend

Socket.IO server: transcription, streaming generation, speech synthesis, and
the interruption handling that decides whether the caller meant to stop you.

See the [root README](../README.md) for what the project is and how the pieces
fit together.

## Run

```bash
npm install
cp .env.example .env     # paste your key into GROQ_API_KEY
npm run dev              # http://localhost:3000
```

Get a free key at https://console.groq.com — one key covers both speech-to-text
and the LLM. Check it was picked up:

```bash
curl -s localhost:3000/health
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with reload on change |
| `npm test` | Truncation, backchannel classification, silence artefacts |
| `npm run build` | Compile to `dist/` |
| `npm run fetch-voice` | Download a Piper voice model (see below) |

## Speech synthesis

`TTS_PROVIDER` selects the engine:

- **`say`** — macOS built-in. No setup, nothing to download. Use this locally.
- **`piper`** — bundled binary plus an ONNX voice. Used in Docker and
  deployment.

The voice model is ~63MB and deliberately not committed: git would keep it in
history forever, GitHub warns past 50MB, and it belongs to its publisher rather
than this repository. Fetch it when you need it:

```bash
npm run fetch-voice                      # en_US-lessac-medium
npm run fetch-voice -- en_GB-alba-medium # anything from the Piper catalogue
```

Voices: https://huggingface.co/rhasspy/piper-voices

Note that `piper-tts` 1.8.0 cannot synthesise on macOS arm64 at all — the wheel
ships an espeak-ng data path pointing at its own CI build machine and the native
bridge ignores the directory it is given. The Linux wheel is unaffected, which
is why local development uses `say`.

## Layout

```
src/
  server.ts                    socket protocol, call state, interruption triage
  services/conversation.ts     history; truncation to what was actually heard
  services/backchannel.ts      "mhm" vs a real interruption; silence artefacts
  services/sentenceChunker.ts  token stream → speakable sentences
  services/llmService.ts       streaming LLM, provider-agnostic, cancellable
  services/ttsService.ts       TTS, provider-agnostic, cancellable
  services/whisperService.ts   Groq Whisper STT
  services/audioProcessor.ts   ffmpeg webm → 16 kHz mono wav, trimmed to onset
  services/timeline.ts         per-stage turn timings
  smoke.ts                     tests
```
