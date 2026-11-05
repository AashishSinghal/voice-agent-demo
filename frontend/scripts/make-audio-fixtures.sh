#!/bin/sh
# Regenerates the spoken-command clips used by src/lib/callSimulation.test.ts.
# macOS only (`say`) plus ffmpeg. Real recordings can be dropped into the same
# directory and listed in manifest.json; these only seed it.
set -e
out="$(dirname "$0")/../src/lib/fixtures/audio"
mkdir -p "$out"
tmp="$(mktemp -d)"
clip() { # name rate text
  say -r "$2" -o "$tmp/$1.aiff" "$3"
  ffmpeg -loglevel error -y -i "$tmp/$1.aiff" -ar 16000 -ac 1 "$out/$1.wav"
}
clip stop-quick 200 "stop"
clip yes-quick 200 "yes"
clip no-quick 200 "no"
clip question 180 "what is the weather like in Paris today"
# 120 ms of noise: a cough or a door, not a word.
ffmpeg -loglevel error -y -f lavfi -i "anoisesrc=d=0.12:c=pink:r=16000:a=0.5" -ac 1 "$out/cough.wav"
# Steady fan, a door slam (short low thump) and a hum: none is a turn.
ffmpeg -loglevel error -y -f lavfi -i "anoisesrc=d=2:c=brown:r=16000:a=0.05" -ac 1 "$out/fan.wav"
ffmpeg -loglevel error -y -f lavfi -i "anoisesrc=d=0.2:c=brown:r=16000:a=0.8" -af "afade=t=out:d=0.2" -ac 1 "$out/door.wav"
ffmpeg -loglevel error -y -f lavfi -i "sine=f=120:d=2:r=16000" -af "volume=0.05" -ac 1 "$out/hum.wav"
rm -rf "$tmp"
