#!/usr/bin/env bash
#
# Does the image survive the free tier's 512MB?
#
# Idle usage is not the question — the peak is. The worst moment is Piper
# holding the voice model in memory (onnxruntime) while ffmpeg converts
# inbound audio and Node holds the socket state, all counted against one
# cgroup limit.
#
# Runs the container under the real constraint and reads the kernel's
# high-water mark rather than sampling `docker stats`, which can miss a spike
# between polls.
#
# Usage: ./scripts/check-memory.sh [image] [memory]

set -euo pipefail

IMAGE="${1:-voice-agent:test}"
LIMIT="${2:-512m}"
NAME="voice-agent-memcheck"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "Starting $IMAGE under $LIMIT (swap disabled, as on a container host)"
docker run -d --name "$NAME" \
  --memory="$LIMIT" --memory-swap="$LIMIT" \
  -e GROQ_API_KEY=not-needed-for-this-check \
  -e TTS_PROVIDER=piper \
  "$IMAGE" >/dev/null

# Wait for the server rather than sleeping a guessed interval.
for _ in $(seq 1 30); do
  if docker exec "$NAME" node -e "fetch('http://localhost:3000/health').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "Driving load: repeated synthesis plus a concurrent ffmpeg conversion"

docker exec "$NAME" sh -c '
  # Something for ffmpeg to chew on, shaped like an inbound clip.
  ffmpeg -y -f lavfi -i "sine=frequency=440:duration=8:sample_rate=48000" \
    -c:a libopus /tmp/in.webm >/dev/null 2>&1

  node --input-type=module -e "
    const tts = await import(\"/app/dist/services/ttsService.js\");
    const audio = await import(\"/app/dist/services/audioProcessor.js\");

    const sentences = [
      \"Software engineering is the disciplined way of building systems.\",
      \"It blends computer science with project management and practice.\",
      \"The goal is software that is reliable, scalable and easy to change.\",
    ];

    // Synthesis and conversion overlapping is the realistic worst case:
    // the agent speaks a sentence while the next clip arrives.
    for (let round = 0; round < 4; round++) {
      await Promise.all([
        (async () => {
          for (const s of sentences) await tts.synthesizeSpeechFromText(s);
        })(),
        audio.convertToWav(\"/tmp/in.webm\", 0),
      ]);
      process.stdout.write(\".\");
    }
    console.log(\" done\");
  "
'

echo
echo "--- result ---"

peak_bytes=$(docker exec "$NAME" sh -c 'cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null')
limit_bytes=$(docker exec "$NAME" sh -c 'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null')

peak_mb=$(( peak_bytes / 1024 / 1024 ))
limit_mb=$(( limit_bytes / 1024 / 1024 ))
headroom=$(( limit_mb - peak_mb ))

echo "peak:     ${peak_mb} MB"
echo "limit:    ${limit_mb} MB"
echo "headroom: ${headroom} MB"

# Did the kernel kill anything?
oom=$(docker inspect "$NAME" --format '{{.State.OOMKilled}}')
status=$(docker inspect "$NAME" --format '{{.State.Status}}')
echo "oom-killed: $oom   container: $status"

echo
if [ "$oom" = "true" ] || [ "$status" != "running" ]; then
  echo "FAIL — the container did not survive. Switch TTS off Piper."
  exit 1
elif [ "$headroom" -lt 80 ]; then
  echo "TIGHT — under 80MB spare. It may survive here and OOM under real traffic."
  exit 1
else
  echo "PASS — fits with room to spare."
fi
