#!/bin/bash

# Create test audio files using macOS say command + ffmpeg

echo "🎤 Creating test audio files..."
echo ""

# Array of test queries
declare -a queries=(
    "Where is my money?"
    "How do I check my transfer status?"
    "When will my transfer arrive?"
    "Why is my transfer taking so long?"
    "What is a proof of payment?"
    "How do I open an account?"
)

mkdir -p test-audio

for i in "${!queries[@]}"; do
    query="${queries[$i]}"
    filename="test-audio/test-$((i+1)).wav"

    echo "Creating: $query"

    # Use say to generate AIFF, then convert to WAV with ffmpeg
    say "$query" -o temp.aiff
    ffmpeg -i temp.aiff -ar 16000 -ac 1 -y "$filename" 2>/dev/null
    rm temp.aiff

    echo "✅ Saved: $filename"
done

echo ""
echo "🎉 Created ${#queries[@]} test audio files in test-audio/"
echo ""
echo "Test with:"
echo "  curl -X POST http://localhost:3000/api/process-audio -F \"audio=@test-audio/test-1.wav\""
