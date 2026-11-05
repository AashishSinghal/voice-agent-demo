# Latency and VAD improvements

Work through these in order. Tick a step only when its measurement is in place
and the numbers are recorded in the "Results" section at the bottom.

Sources: ElevenLabs, "Voice agent latency optimization" and "What is voice
activity detection". Neither gives backchannel or barge-in guidance; those
come from our own work. The article's budget is illustrative, not a guarantee.

**Target:** time to first audio (caller stops speaking to the first sample
playing) under 800 ms at P50 and under 1.5 s at P95.

## Where we stand (as of 2026-11-05)

- Endpoint wait is 900 ms in a normal turn (`TIMING.ENDPOINT_MS`). That alone
  exceeds the article's whole 680 ms P50 budget. Biggest single gap.
- Server logs per-turn `stt`, `first token`, `first audio`, `total`
  (`backend/src/server.ts`). Its clock starts when the clip arrives, so it
  leaves out the endpoint wait, upload, and browser decode and playback start.
  Not yet verified exactly where the client timeline starts and ends.
- No P50 or P95 across turns. Server-side `first audio` was 1.5-2.9 s in one
  local call, so caller-felt latency is higher.
- VAD is an energy (RMS) gate with an adaptive noise floor (`lib/vad.ts`). It
  cannot tell a voice from a cough or fan, and missed the quiet "stop".

## Steps

### 1. Measure (nothing else changes until this exists)
- [x] Browser: record "caller stopped speaking" to "first audio actually
      playing" per turn, and show P50 and P95 per call in the debug panel and
      the diagnostics bundle. Done 2026-11-05: the clock starts at the endpoint
      window before speech-end (`turnTaking.ts`) and stops on the first chunk's
      `playing` event (`useAudioPlayback.ts`); logged as `timeline complete
      kind=turn`. Not yet verified in a live call.
- [ ] Script: run N turns (about 50, spaced 300 ms apart) against a provider
      and report P50 and P95, not the mean. One script, reused by steps 2-6.
- [x] VAD: count false positives (noise sent as a turn) and false negatives
      (speech dropped) over a clip set in `callSimulation.test.ts`. Baseline
      2026-11-05 (20 clips, 10 synthetic + 10 real): 0 false positive, 0
      false negative, 2 known limitations, both step 3's target: a steady 2 s
      hum and a real cough are sent as turns.
- [~] Grow the clip set with real audio (10 real clips from a call on
      2026-11-05 are in `fixtures/audio/real/`, run in CI; still missing:
      room noise, a door, music, more of the owner's short words): the owner's voice, fan or room
      noise, a cough, a door, background music. Recording is on by default, so
      debug bundles now carry the audio.

### 2. Try ElevenLabs for STT and TTS
- [ ] Needs `ELEVENLABS_API_KEY` in `backend/.env` (never in chat or commits).
- [ ] Add `STT_PROVIDER` and `TTS_PROVIDER=elevenlabs`, pluggable like the
      existing providers. Call sites must not care which is active.
- [ ] Run the step 1 script against Groq and ElevenLabs; record both.
- [ ] Free-tier credits are limited; expect a short trial only.

### 3. Better VAD
- [ ] Neural VAD (Silero is the usual choice) in the browser, replacing the
      energy gate in `lib/vad.ts`. Run it on the simulator clips first; switch
      the page over only if false positives and negatives improve.
- [ ] Cost: model about 2 MB plus a dependency. (Silero details are from
      memory, not checked against current docs.)

### 4. Shorter, smarter end-of-turn
- [ ] Cheap first: shorter wait after a clearly finished sentence, longer
      after "and", "so" or a trailing pause. Must stay a set lookup, not a
      model call (see AGENTS.md).
- [ ] Later: VAD plus a turn-detection model that judges whether the thought
      is finished. Biggest latency win and biggest piece of work.
- [ ] Track interruption rate (agent cutting the caller off) alongside
      latency, so a shorter window is not a silent regression.

### 5. Start the LLM earlier
- [ ] Feed stable partial transcripts to the LLM, revising if the final
      differs. Needs streaming STT (Scribe Realtime; Groq Whisper is
      batch-only).

### 6. Trim the tail
- [ ] Smaller first TTS chunk; later chunks matter less.
- [ ] Player buffer: 50-150 ms on a stable link (article); check ours.
- [ ] Match audio format to skip transcoding (PCM or MP3 for the browser).
- [ ] Run the backend near users and measure per region. Render free tier is
      one region and sleeps after 15 minutes.

## Results

| Date | Change | P50 | P95 | Notes |
|---|---|---|---|---|
| 2026-11-05 | baseline, local, `say` voice | ~3.6 s | n/a | n=4 ordinary turns across two calls: 3678, 3530, 4016, 3617 ms; 900 ms of it is the endpoint wait |
| 2026-11-05 | brain on, local, Neon Ohio (from India), `say` voice | 4.6-7.4 s (n=2) | n/a | server first token 1.5-4.3 s vs ~0.5 s gateway-only. Direct to brain: `context` event at ~1.05 s, first token 1.4-2.1 s, `done` +1.1 s. Each Neon query ~270 ms from this machine |
| 2026-11-05 | brain on Vercel (iad1) + Neon Ohio, timed directly from India, no gateway or voice | n/a | n/a | first token 0.79-1.0 s on turns 2-5 (2.25 s cold first turn) vs 1.4-2.1 s for the local brain; `context` event 0.5-1.0 s. n=5, includes the India-to-Virginia network leg |

