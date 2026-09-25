# Voice Agent

Project directives live in **[AGENTS.md](./AGENTS.md)** — read it before working
in this repo. The short version:

- **Reaction latency is the product.** Keep the interruption path fast; check
  changes against the latency budget in `README.md`.
- **Backchannel classification stays a set lookup**, never a model call.
- **History holds only what the caller actually heard**; the unsaid remainder is
  kept for "go back".
- **The free Render box (0.1 vCPU) does no signal processing**: hosted TTS,
  no transcoding (remux only). Stay inside Groq's free quota.
- The client heartbeats `playback:progress` while playing so the watchdog does
  not cut off long answers. Be careful with async `MediaRecorder.onstop`.
- Test with `cd backend && npm test`; `cd frontend && npm run build` and
  `npm run lint`. Never commit `.env` or the Piper voice model.

@AGENTS.md
