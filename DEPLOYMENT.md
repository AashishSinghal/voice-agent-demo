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

The repo carries the config, so this is mostly clicking.

### 1. Backend → Render

1. **New → Blueprint**, pick this repo. Render reads [`render.yaml`](./render.yaml)
   and builds [`backend/Dockerfile`](./backend/Dockerfile).
2. When it asks for the two secrets:
   - `GROQ_API_KEY` — from https://console.groq.com/keys
   - `CLIENT_URL` — leave blank for now, you do not have the Vercel URL yet.
3. Wait for the first build. It installs ffmpeg and Piper and downloads the
   voice model, so expect a few minutes.
4. Check it came up: `curl https://<your-app>.onrender.com/health` — you want
   `"groqKey": "configured"`.

### 2. Frontend → Vercel

1. **Add New → Project**, pick this repo, set **Root Directory** to `frontend`.
   [`frontend/vercel.json`](./frontend/vercel.json) supplies the rest.
2. Environment variable: `VITE_SERVER_URL=https://<your-app>.onrender.com`
3. Deploy.

### 3. Close the loop

Set `CLIENT_URL` on Render to the Vercel URL and redeploy. This is the CORS
origin — until it matches, the browser connects to nothing and the page sits
there looking broken with no error worth reading.

### 4. Keep it awake

**UptimeRobot → HTTP monitor → `https://<your-app>.onrender.com/health`, every
5 minutes.** Without this the first visitor waits 30-50 seconds for a cold
start, which is worse than no demo.

### 5. Optional: monitoring

Langfuse Cloud Hobby for LLM tracing, Sentry for errors. Both free, both just
environment variables.

## Does it fit in 512MB?

Yes, measured rather than assumed.

| | |
|---|---|
| Image | 416 MB |
| Idle | 54 MB (10% of the limit) |
| Peak under load | **343 MB** |
| Headroom | **169 MB** |
| OOM killed | no |

The load was the realistic worst case: Piper synthesising sentence after
sentence with the voice model resident in onnxruntime, overlapping with ffmpeg
converting an inbound clip, repeated four times. Peak comes from the kernel's
own high-water mark (`/sys/fs/cgroup/memory.peak`) rather than sampling
`docker stats`, which can miss a spike between polls.

Reproduce with:

```bash
cd backend
docker build --platform linux/amd64 -t voice-agent .
./scripts/check-memory.sh voice-agent 512m
```

The script fails on an OOM kill and also on less than 80MB of headroom — barely
fitting in a quiet test means OOMing under real traffic.

Two caveats. The measurement was taken under QEMU emulation on arm64, so the
figures are indicative rather than exact for Render's x86 hardware; the margin
is wide enough that this should not change the answer. And it exercised one
caller — the free tier is a single instance, so concurrent callers share that
512MB.

The `--platform` flag is not optional: an arm64 image built on an Apple laptop
will not start on Render.

## If 512 MB turns out to be tight

Piper, ffmpeg and Node together are close to the limit. If it OOMs, swap TTS to
**Groq's Orpheus** models (they replaced `playai-tts` in 2026) — that removes the
Piper binary and the model file from the image entirely, at the cost of spending
your Groq request budget on speech as well as text. The TTS call is isolated in
`ttsService.ts` behind a `TTS_PROVIDER` switch, so it is one new branch in one
file plus an environment variable — no change to the pipeline around it.

## Honest limitations to mention in an interview

- Single instance, no horizontal scaling — fine for a demo, not for production.
- Free-tier rate limits are the real capacity ceiling, not the architecture.
- No persistence: conversation state lives in memory per socket and dies with it.
