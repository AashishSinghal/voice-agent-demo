# Voice Agent Frontend

React frontend for AI voice agent call interface.

## Setup

```bash
pnpm install
```

## Start

```bash
pnpm dev
```

Frontend runs on http://localhost:5173

## Usage

1. Ensure backend is running on http://localhost:3000
2. Click "Start Call"
3. Speak your question after the greeting
4. Bot responds or transfers to human agent

## Stack

- React + TypeScript
- Vite
- Socket.io client
- Web Audio API (recording + VAD)
- Zustand (state management)
