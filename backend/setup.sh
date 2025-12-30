#!/bin/bash

set -e

echo ""
echo "Voice Agent Backend Setup"
echo "=========================="
echo ""

ERRORS=0
WARNINGS=0

# Create directories
mkdir -p models/piper uploads

# Check Node.js
if command -v node &> /dev/null; then
    echo "✓ Node.js $(node --version)"
else
    echo "✗ Node.js not found - install from https://nodejs.org"
    ERRORS=$((ERRORS + 1))
fi

# Check pnpm
if command -v pnpm &> /dev/null; then
    echo "✓ pnpm $(pnpm --version)"
else
    echo "⚠ pnpm not found - install: npm install -g pnpm"
    WARNINGS=$((WARNINGS + 1))
fi

# Check Ollama
if command -v ollama &> /dev/null; then
    echo "✓ Ollama installed"

    if curl -s http://localhost:11434/api/tags &> /dev/null; then
        echo "✓ Ollama running"

        if ollama list 2>/dev/null | grep -q "phi3"; then
            echo "✓ phi3 model available"
        else
            echo "Installing phi3 model..."
            ollama pull phi3
        fi
    else
        echo "⚠ Ollama not running - start: ollama serve"
        WARNINGS=$((WARNINGS + 1))
    fi
else
    echo "✗ Ollama not found - install: https://ollama.com"
    ERRORS=$((ERRORS + 1))
fi

# Check FFmpeg
if command -v ffmpeg &> /dev/null; then
    echo "✓ FFmpeg installed"
else
    echo "✗ FFmpeg not found - install: brew install ffmpeg"
    ERRORS=$((ERRORS + 1))
fi

# Check Piper
PIPER_BIN=""
if command -v piper &> /dev/null; then
    PIPER_BIN=$(which piper)
    echo "✓ Piper: $PIPER_BIN"
elif [ -f "$HOME/.local/bin/piper" ]; then
    PIPER_BIN="$HOME/.local/bin/piper"
    echo "✓ Piper: $PIPER_BIN"
else
    echo "✗ Piper not found - install: pipx install piper-tts"
    ERRORS=$((ERRORS + 1))
fi

echo ""

# Download Piper model
PIPER_MODEL_DIR="$(pwd)/models/piper"
PIPER_MODEL_FILE="$PIPER_MODEL_DIR/en_US-lessac-medium.onnx"
PIPER_MODEL_JSON="$PIPER_MODEL_DIR/en_US-lessac-medium.onnx.json"

if [ -f "$PIPER_MODEL_FILE" ] && [ -f "$PIPER_MODEL_JSON" ]; then
    echo "✓ Piper model exists"
else
    echo "Downloading Piper voice model (60MB)..."

    curl -L -o "$PIPER_MODEL_FILE" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx"

    curl -L -o "$PIPER_MODEL_JSON" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"

    if [ -f "$PIPER_MODEL_FILE" ] && [ -f "$PIPER_MODEL_JSON" ]; then
        echo "✓ Model downloaded"
    else
        echo "✗ Model download failed"
        ERRORS=$((ERRORS + 1))
    fi
fi

echo ""

# Configure .env
if [ -f ".env" ]; then
    echo "Backing up .env to .env.backup"
    cp .env .env.backup
fi

cp .env.example .env

# Update paths
if [ -n "$PIPER_BIN" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^PIPER_BIN=.*|PIPER_BIN=$PIPER_BIN|g" .env
        sed -i '' "s|^PIPER_MODEL_PATH=.*|PIPER_MODEL_PATH=$PIPER_MODEL_DIR|g" .env
    else
        sed -i "s|^PIPER_BIN=.*|PIPER_BIN=$PIPER_BIN|g" .env
        sed -i "s|^PIPER_MODEL_PATH=.*|PIPER_MODEL_PATH=$PIPER_MODEL_DIR|g" .env
    fi
fi

echo "✓ .env configured"

# Check GROQ_API_KEY
if grep -q "your_groq_api_key_here" .env; then
    echo "⚠ Set GROQ_API_KEY in .env (get from https://console.groq.com)"
    WARNINGS=$((WARNINGS + 1))
fi

echo ""

# Install dependencies
echo "Installing dependencies..."
if command -v pnpm &> /dev/null; then
    pnpm install
else
    npm install
fi

echo ""
echo "=========================="

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo "✓ Setup complete"
    echo ""
    echo "Start: pnpm dev"
elif [ $ERRORS -eq 0 ]; then
    echo "⚠ Setup complete with $WARNINGS warning(s)"
    echo ""
    echo "Start: pnpm dev"
else
    echo "✗ Setup incomplete: $ERRORS error(s)"
    echo "Fix errors above before starting"
    exit 1
fi

echo ""
