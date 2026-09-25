# Evaluation data

A corpus that accumulates from ordinary use rather than from a labelling
session.

## Importing a call

Record a call (debug panel → *Record this call*), download the bundle, then:

```bash
cd backend
npm run import:call -- ~/Downloads/voice-agent-1790375204729.zip
```

That produces `eval/corpus/<callId>/`:

```
you.webm            the caller's track, remuxed so it carries a duration
agent.webm          the agent's track
clips/000-turn.webm one clip per utterance, cut to the detected speech
entries.json        the labels
```

## Where the labels come from

The bundle's log already records when the caller spoke, what was transcribed,
how any over-speech was classified, and whether it was thrown away. The
importer joins that to the audio — the byte count of a clip appears both on the
send and on its transcript, which makes the join reliable even when events
arrive out of order.

So each clip arrives labelled:

```json
{
  "clip": "clips/000-turn.webm",
  "label": "turn",
  "transcript": "Explain Software Engineering.",
  "transcriptVerified": false,
  "classification": null,
  "spokenMs": 1359,
  "audio": { "startSec": 8, "endSec": 9.96 }
}
```

`transcript` is what the agent heard, not what was said. It is a starting
point: correct the ones that are wrong and set `transcriptVerified` to true.
That is the only manual step, and it is editing rather than transcribing.

## Clips are cut by re-encoding

A stream copy can only cut on cluster boundaries, which moved clip edges by
seconds in testing and would have made every label point at the wrong audio.
Re-encoding to Opus is cheap for clips this short and lands where the log says.

## What is committed

`entries.json` is committed; the audio is not. Recordings are someone's voice
and grow without bound, while the labels are small and still drive text-level
scoring — classification, the silence-artefact filter — on their own.
