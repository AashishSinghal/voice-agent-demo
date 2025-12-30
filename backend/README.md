# Voice Agent Backend

Backend server for AI voice agent using Groq Whisper, Ollama phi3, and Piper TTS.

## Setup

```bash
chmod +x setup.sh
./setup.sh
```

Add your Groq API key to `.env`:
```
GROQ_API_KEY=your_key_here
```

Get key from: https://console.groq.com

## Start

```bash
pnpm dev
```

Server runs on http://localhost:3000

## Stack

- Groq Whisper (STT)
- Ollama phi3 (LLM)
- Piper TTS (TTS)
- Socket.io (WebSocket)
