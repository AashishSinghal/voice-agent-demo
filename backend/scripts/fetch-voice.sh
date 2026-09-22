#!/usr/bin/env bash
#
# Download a Piper voice model.
#
# The model is ~63MB and is not committed: git would keep it in history
# forever, GitHub warns past 50MB, and it is a redistributable artefact that
# belongs to its publisher rather than this repository.
#
# Only needed for TTS_PROVIDER=piper — the Docker image and Linux hosts.
# Local development on macOS uses the built-in `say` and needs none of this.
#
# Usage:
#   ./scripts/fetch-voice.sh                    # default voice
#   ./scripts/fetch-voice.sh en_GB-alba-medium  # a specific voice
#
# Voices: https://huggingface.co/rhasspy/piper-voices

set -euo pipefail

VOICE="${1:-en_US-lessac-medium}"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models/piper"
BASE="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"

# en_US-lessac-medium -> en/en_US/lessac/medium
lang="${VOICE%%-*}"                 # en_US
rest="${VOICE#*-}"                  # lessac-medium
name="${rest%%-*}"                  # lessac
quality="${rest#*-}"                # medium
family="${lang%%_*}"                # en

URL="$BASE/$family/$lang/$name/$quality/$VOICE"

mkdir -p "$DEST"

download() {
  local url="$1" out="$2"

  if [ -s "$out" ]; then
    echo "  already present: $(basename "$out")"
    return
  fi

  echo "  downloading $(basename "$out")…"
  if ! curl -fsSL --retry 3 -o "$out" "$url"; then
    rm -f "$out"
    echo "  failed: $url" >&2
    echo "  check the voice name against https://huggingface.co/rhasspy/piper-voices" >&2
    exit 1
  fi
}

echo "Fetching Piper voice '$VOICE'"
echo "  into $DEST"

download "$URL.onnx" "$DEST/$VOICE.onnx"
download "$URL.onnx.json" "$DEST/$VOICE.onnx.json"

# A wrong path returns an HTML error page with a 200, so check it looks like a model.
size=$(wc -c < "$DEST/$VOICE.onnx" | tr -d ' ')
if [ "$size" -lt 1000000 ]; then
  echo "  '$VOICE.onnx' is only ${size} bytes — that is not a model." >&2
  rm -f "$DEST/$VOICE.onnx" "$DEST/$VOICE.onnx.json"
  exit 1
fi

echo
echo "Done — $(du -h "$DEST/$VOICE.onnx" | cut -f1) model ready."
echo "To use it, set in backend/.env:"
echo "  TTS_PROVIDER=piper"
echo "  PIPER_MODEL=$VOICE"
