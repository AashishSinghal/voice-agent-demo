#!/bin/bash

echo "Voice Agent Backend Setup"
echo "=========================="
echo ""

# Create directories
mkdir -p models/piper uploads

# Check Ollama
if command -v ollama &> /dev/null; then
    echo "✓ Ollama installed"
    if ollama list | grep -q "phi3"; then
        echo "✓ phi3 model available"
    else
        echo "Installing phi3..."
        ollama pull phi3
    fi
else
    echo "✗ Ollama not found - install: curl -fsSL https://ollama.com/install.sh | sh"
fi

# Check FFmpeg
if command -v ffmpeg &> /dev/null; then
    echo "✓ FFmpeg installed"
else
    echo "✗ FFmpeg not found - install: brew install ffmpeg"
fi

# Check Piper
if command -v piper &> /dev/null; then
    echo "✓ Piper installed"
else
    echo "✗ Piper not found"
    echo "  Install: brew install pipx && pipx install piper-tts"
fi

# Download Piper model
if [ ! -f "models/piper/en_US-lessac-medium.onnx" ]; then
    echo ""
    echo "Downloading Piper model (60MB)..."
    curl -L -o models/piper/en_US-lessac-medium.onnx \
        https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx
    curl -L -o models/piper/en_US-lessac-medium.onnx.json \
        https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
    echo "✓ Piper model downloaded"
else
    echo "✓ Piper model exists"
fi

# Create .env
if [ ! -f ".env" ]; then
    echo ""
    echo "Creating .env file..."
    cp .env.example .env
    # Update piper path
    PIPER_BIN=$(which piper 2>/dev/null || echo "/Users/$USER/.local/bin/piper")
    sed -i.bak "s|PIPER_BIN=.*|PIPER_BIN=$PIPER_BIN|g" .env
    sed -i.bak "s|PIPER_MODEL_PATH=.*|PIPER_MODEL_PATH=$(pwd)/models/piper|g" .env
    rm .env.bak
    echo "✓ .env created"
    echo "! Add GROQ_API_KEY to .env (get from: https://console.groq.com)"
else
    echo "✓ .env exists"
fi

echo ""
echo "Setup complete!"
echo ""
echo "Next: pnpm dev"
