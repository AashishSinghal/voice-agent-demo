# Frontend

The call interface: a state-coloured orb, a transcript, and a debug panel with
live microphone calibration, per-stage latency and an exportable diagnostic log.

See the [root README](../README.md) for what the project is and how the pieces
fit together.

## Run

```bash
npm install
npm run dev     # http://localhost:5173
```

The backend must be running first. The browser only grants microphone access on
`localhost` or over HTTPS.

Point at a non-default backend with `VITE_SERVER_URL`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check and build to `dist/` |
| `npm run preview` | Serve the production build |

## Debugging a call

Open **debug** (top right):

- **Microphone** — live level against thresholds calibrated from your room. If
  the bar never clears the green marker while you talk normally, detection is
  the problem and nothing downstream will fire.
- **Last turn timeline** — client and server stages merged, server rows
  indented.
- **Reaction benchmark** — time from hearing you to the agent acting, split by
  interruption and backchannel.
- **Diagnostics** — **Download bundle** produces one zip: the full timeline,
  both audio tracks if the call was recorded, a manifest with their durations,
  and a README. The pieces are only useful together, so they travel together.

`__diag.toText()` and `__botStore` are exposed on `window` in dev.

## Layout

```
src/
  components/VoiceAgent/Orb.tsx         state-coloured, level-reactive orb
  components/VoiceAgent/Transcript.tsx  conversation, interruptions marked
  components/VoiceAgent/DebugPanel.tsx  state, mic meter, latency, event log
  hooks/useMicStream.ts                 one mic stream per call
  hooks/useVoiceActivityDetection.ts    adaptive noise gate, speech edges
  hooks/useAudioPlayback.ts             queue with pause/resume/stop
  hooks/useAudioRecorder.ts             continuous capture
  hooks/useSocketConnection.ts          streaming protocol
  stores/useBotStateStore.ts            call state, timeline, benchmarks
  lib/diagnostics.ts                    exportable session log
```
