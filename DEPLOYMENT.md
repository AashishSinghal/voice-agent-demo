# Deploying the demo for free

Target: a public URL you can put in an application or open in an interview,
running for 2–3 months at **$0/month**. Researched September 2026 — free tiers
move fast, so re-check anything before relying on it.

## The shape of it

```
Browser ──WebSocket──> Backend (Render free, Docker)
   │                      ├─ STT  → Groq Whisper        (free tier)
   │                      ├─ LLM  → Groq gpt-oss-20b    (free tier, streaming)
   │                      └─ TTS  → Groq Orpheus       (hosted, no local CPU)
   └── static frontend on Vercel (free)
```

| Piece | Choice | Free allowance | Why |
|---|---|---|---|
| Frontend | **Vercel** | Unlimited hobby static | Trivial, instant, custom domain |
| Backend | **Render free web service** | 750 h/mo, 512 MB, 0.1 vCPU | One of the few remaining always-free tiers that supports **Docker + WebSockets** with no credit card |
| STT | **Groq Whisper** | 20 RPM · 2,000 req/day · **8 h audio/day** | Already what the code uses; effectively unlimited at demo volume |
| LLM | **Groq `openai/gpt-oss-20b`** | 30 RPM · 1,000 req/day · 200K tokens/day | Fast enough for voice; streaming supported |
| TTS | **Groq Orpheus** | shares the 1,000/day | Hosted, because the free instance has 0.1 vCPU |
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
3. The build takes well under a minute — it installs ffmpeg and nothing else
   heavy, since synthesis is hosted.
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

## The free tier's real constraint is CPU, not memory

Memory was never the problem. The free instance gives **0.1 vCPU**, and that is
what hurts. Measured on a deployed call:

| Stage | Local | Render free | Why |
|---|---|---|---|
| LLM first token | 440 ms | **365 ms** | network call — unaffected |
| Whisper | 400 ms | 400–1100 ms | network call — unaffected |
| ffmpeg transcode | 120 ms | **5,200 ms** | CPU |
| Piper synthesis | 560 ms | **28,900 ms** | CPU |

One turn took 104 seconds end to end. Everything computed on the box ran 25–50×
slower; everything behind an API was fine.

So the deployment does no signal processing:

- **TTS is hosted** (`TTS_PROVIDER=groq`, Orpheus). Synthesis becomes a network
  call. Piper is still supported for a paid instance with real CPU — build with
  `--build-arg INSTALL_PIPER=true`.
- **Audio is never transcoded.** Whisper accepts webm directly, so a clip that
  needs no trim is forwarded untouched, and one that does is remuxed with a
  stream copy. No decode, no re-encode.

Dropping local synthesis also shrank the image from **1.48 GB to 253 MB**, and
the build from several minutes to 18 seconds.

Idle memory is 57 MB of the 512 MB. `scripts/check-memory.sh` still exists for
the Piper build, where memory is worth checking:

```bash
docker build --platform linux/amd64 --build-arg INSTALL_PIPER=true -t voice-agent .
./scripts/check-memory.sh voice-agent 512m
```

Under that build the peak was 343 MB with 169 MB of headroom — it fits, it is
simply far too slow to use.

The `--platform` flag is not optional: an arm64 image built on an Apple laptop
will not start on Render.

## Quota

Hosted TTS spends the Groq free tier's 1,000 daily requests. A three-sentence
answer costs three TTS calls plus one LLM call plus one transcription — roughly
five per turn, so about 200 turns a day. Ample for a demo, worth knowing before
sharing the link widely.

## Honest limitations to mention in an interview

- Single instance, no horizontal scaling — fine for a demo, not for production.
- Free-tier rate limits are the real capacity ceiling, not the architecture.
- No persistence: conversation state lives in memory per socket and dies with it.
