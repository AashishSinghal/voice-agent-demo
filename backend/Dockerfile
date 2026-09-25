# Backend image for a free-tier host (Render).
#
# Two stages so the TypeScript toolchain and dev dependencies do not ship.
# Built for linux/amd64 — free hosts are x86, and an arm64 image built on an
# Apple laptop will not start there.

# ---------- build ----------
FROM node:20-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime ----------
FROM node:20-slim

# ffmpeg converts the browser's webm to the wav Whisper wants.
# python3 is only here for Piper; curl fetches the voice model.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-venv \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Piper lives in a venv: Debian marks the system Python as externally managed
# and refuses a global pip install. The Linux wheel works, unlike the macOS
# arm64 one, which is why local development uses `say` instead.
RUN python3 -m venv /opt/piper \
    && /opt/piper/bin/pip install --no-cache-dir piper-tts==1.8.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Fetched at build time rather than committed: ~63MB that git would keep
# forever, and it belongs to its publisher.
COPY scripts ./scripts
RUN ./scripts/fetch-voice.sh

ENV NODE_ENV=production \
    PORT=3000 \
    LLM_PROVIDER=groq \
    TTS_PROVIDER=piper \
    PIPER_BIN=/opt/piper/bin/piper \
    PIPER_MODEL=en_US-lessac-medium \
    PIPER_MODEL_PATH=/app/models/piper

EXPOSE 3000

# The host's health check uses this too; it reports whether the Groq key was
# actually picked up, which is the usual first-deploy mistake.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
