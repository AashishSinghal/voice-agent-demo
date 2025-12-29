# Voice Agent Backend

Voice agent for Wise customer support using Groq Whisper, Ollama phi3, and Piper TTS.

## Stack

- **STT**: Groq Whisper API (free)
- **LLM**: Ollama + phi3 (local)
- **TTS**: Piper (local)
- **Audio**: FFmpeg

## Setup

```bash
# Run setup script
./setup.sh

# Install dependencies
pnpm install

# Add Groq API key to .env
GROQ_API_KEY=gsk_your_key_here

# Start server
pnpm dev
```

## Test

```bash
# Text query
curl -X POST http://localhost:3000/api/test-query \
  -H "Content-Type: application/json" \
  -d '{"query": "Where is my money?"}'

# Audio processing
curl -X POST http://localhost:3000/api/process-audio \
  -F "audio=@test-audio/test-1.wav"

# Download response audio
curl http://localhost:3000/audio/response_123.wav -o response.wav
afplay response.wav
```

## FAQ Coverage

1. Transfer Status
2. Delivery Timing
3. Completion vs Arrival
4. Transfer Delays
5. Proof of Payment
6. Reference Number
7. Out of Scope → deflects (uses pre-generated audio)

## Files

```
src/
├── services/
│   ├── audioProcessor.ts    # FFmpeg
│   ├── whisperService.ts    # Groq API
│   ├── ollamaService.ts     # phi3 + FAQs
│   └── piperService.ts      # TTS
├── data/
│   └── faqs.json            # 6 FAQs
└── server.ts                # Express
```
