# Deploying the demo for free

Target: a public URL you can put in an application or open in an interview,
running for 2–3 months at **$0/month**. Researched September 2026 — free tiers
move fast, so re-check anything before relying on it.

## The shape of it

```
Browser ──WebSocket──> Backend (Render free, Docker)
   │                      ├─ STT  → Groq Whisper        (free tier)
   │                      ├─ LLM  → Groq gpt-oss-20b    (free tier, streaming)
   │                      └─ TTS  → Piper, in the image (no API, no limits)
   └── static frontend on Vercel (free)
```

| Piece | Choice | Free allowance | Why |
|---|---|---|---|
| Frontend | **Vercel** | Unlimited hobby static | Trivial, instant, custom domain |
| Backend | **Render free web service** | 750 h/mo, 512 MB, 0.1 vCPU | One of the few remaining always-free tiers that supports **Docker + WebSockets** with no credit card |
| STT | **Groq Whisper** | 20 RPM · 2,000 req/day · **8 h audio/day** | Already what the code uses; effectively unlimited at demo volume |
| LLM | **Groq `openai/gpt-oss-20b`** | 30 RPM · 1,000 req/day · 200K tokens/day | Fast enough for voice; streaming supported |
| TTS | **Piper in the image** | unlimited | No API quota, no extra key. ~50 MB model, runs fine in 512 MB |
| LLM tracing | **Langfuse Cloud Hobby** | free | You already know it; gives you the eval/latency story |
| Errors | **Sentry** | 5K errors/mo free | Catch crashes you'd never see otherwise |
| Uptime | **UptimeRobot** | 50 monitors free | Also solves the cold-start problem below |

**Heroku, Fly.io and Railway are no longer options** — none has a true free tier
in 2026, and Koyeb closed its free Starter tier to new users after the Mistral
acquisition. Render is the practical default.

## The cold-start trap

Render's free tier spins down after 15 minutes of inactivity, and a cold start
takes **30–50 seconds**. A recruiter clicking your link and staring at a blank
page for 40 seconds is worse than no demo.

Fix: point **UptimeRobot at `/health` every 5 minutes**. That keeps the service
warm, and the arithmetic works out — a service running continuously for 31 days
uses 744 hours against the 750-hour monthly allowance. It fits, but only just:
run a second always-on free service and you blow the budget.

## Set LLM_PROVIDER=groq in deployment

This is why the LLM client is provider-agnostic. Ollama needs several GB of RAM
and no free host will give you that. Locally you keep `LLM_PROVIDER=ollama`
(free, offline, no quota); deployed you set `LLM_PROVIDER=groq`. Same code path,
same streaming interface.

## Protect the quota

The free LLM tier is **1,000 requests/day** and a public URL is a public URL.
Before sharing it widely, add:

- a per-IP turn cap (e.g. 20 turns/hour) — a few lines in the socket handler
- a hard daily counter that degrades to a canned "demo limit reached" response
- `maxHttpBufferSize` is already capped at 10 MB, which limits audio abuse

Without these, one bored visitor can exhaust the day's budget.

## Deployment steps

1. **Dockerfile** for the backend — Node 20 slim, plus `ffmpeg` and the Piper
   binary + voice model. Build for `linux/amd64`.
2. **Render** → New Web Service → point at the repo → Docker → free plan.
   Environment: `LLM_PROVIDER=groq`, `GROQ_API_KEY`, `GROQ_MODEL`,
   `CLIENT_URL=https://<your-vercel-domain>`, `PIPER_*`.
3. **Vercel** → import the repo → root `frontend/` → set
   `VITE_SERVER_URL=https://<your-render-domain>`.
4. **UptimeRobot** → HTTP monitor on `https://<render>/health`, 5-minute interval.
5. **Langfuse + Sentry** → create free projects, add the keys as env vars.

## If 512 MB turns out to be tight

Piper, ffmpeg and Node together are close to the limit. If it OOMs, swap TTS to
**Groq's Orpheus** models (they replaced `playai-tts` in 2026) — that removes the
Piper binary and the model file from the image entirely, at the cost of spending
your Groq request budget on speech as well as text. The TTS call is isolated in
`piperService.ts`, so it is a single-file change.

## Honest limitations to mention in an interview

- Single instance, no horizontal scaling — fine for a demo, not for production.
- Free-tier rate limits are the real capacity ceiling, not the architecture.
- No persistence: conversation state lives in memory per socket and dies with it.
