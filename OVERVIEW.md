# Overview

A plain-language account of what this is, how the pieces fit, and what happens
next. The [README](./README.md) is the reference — how to run it, what the
options are. This is the story.

---

## The idea in one paragraph

This is a voice agent you can interrupt. You talk, it listens, it answers out
loud, and you can cut it off mid-sentence the way you would with a person. The
model behind it is small and cheap and could be swapped for a smaller one
tomorrow. That is deliberate: **almost nothing that makes a voice conversation
feel right comes from the model.** It comes from the machinery around it —
knowing when you started talking, knowing whether you meant to interrupt,
remembering what you actually heard rather than what was generated. Wiring up
the model took an afternoon. The machinery took the rest.

---

## One call, from start to finish

Say you open the page and click **Start talking**.

**The microphone opens and stays open.** Not when you start speaking — from the
moment the call begins. This matters more than it sounds. Detecting speech
takes about a quarter of a second of sustained sound, and nobody starts a
sentence at full volume, so by the time anything *notices* you talking, your
first word is already over. Recording continuously means the beginning of your
sentence is always already captured. Early on it was not, and "explain software
engineering" arrived as "engineering".

**The agent greets you**, and while it speaks it is still listening.

**You say something.** A noise gate watches the microphone level and decides
that sound is speech. It does not use a fixed threshold, because microphone
gain varies wildly between machines — a level that is obviously speech on one
laptop sits below the background hiss on another. Instead it measures the room
and sets its thresholds relative to that, continuously.

**You stop.** After a short pause the clip is sent. The server trims it back to
just before you started talking, throwing away the silence and anything the
agent itself was saying, and sends it for transcription.

**The words come back**, and go to the model. As the model writes, its output is
buffered into complete sentences, and each finished sentence is turned into
speech immediately. So you hear the first sentence while the third is still
being written. That is why a reply starts in about a second rather than after
the whole answer exists.

**Now you interrupt.**

Here the agent does something less obvious than stopping. It **pauses**, and
waits to find out what you said. Because "mhm" is not an interruption — it
means *go on* — and a question is. You cannot tell those apart from the sound
alone; you need the words, and the words need transcription. So playback holds,
the interruption is transcribed and classified, and then one of two things
happens: it resumes from exactly where it paused, or it drops what it was
saying and answers you.

The classification is a lookup, not another model call. It sits between you
speaking and the agent reacting, which is the single most latency-sensitive
moment in the whole system.

**And then the important part.** If it really was an interruption, the agent
records only the sentences you actually *heard* — not the ones it had already
generated. Otherwise the next thing it says refers back to a sentence that was
never spoken aloud, and the conversation quietly stops making sense. What it
never got to say is kept aside, so you can ask it to carry on and it can.

---

## Why each piece exists

Almost every component is there because something broke.

**Continuous recording** — because recording on detection loses the first word.

**A noise gate measured from the room** — because a hardcoded threshold was
unreachable on one machine and hair-trigger on another. For a while the agent
only heard shouting.

**A silence-artefact filter** — because transcription models do not return an
empty string for silence. Trained on subtitled video, they return caption
boilerplate: "Thank you." "Thanks for watching." Those became real
conversational turns and the agent answered them.

**Per-recording state instead of shared flags** — because `MediaRecorder` stops
asynchronously, and a shared variable got reset by the next recording before
the previous one finished with it. At one point six recorders were running
simultaneously, and the clip actually being sent was usually an empty one.

**A pause-then-classify interruption path** — because cancelling on any sound
makes the agent impossible to talk over politely.

**Truncated history** — because the agent must know what you heard.

**A watchdog, and then a heartbeat to go with it** — the watchdog recovers a
call that has genuinely stalled. But the browser says nothing while it plays
audio, so a long answer looked exactly like a stalled call, and the watchdog
cut the agent off mid-sentence. The heartbeat is the browser saying *still
playing*.

**An exportable diagnostic log** — the thing that made all of the above
findable. Client events, socket traffic in both directions, the microphone
level over time, and every line the server prints, in one timeline you can
download. Before it existed, bugs took days. After it, minutes.

---

## What it costs

Every turn is priced, even though it runs on a free tier. Knowing the shape of
the bill before it exists is the point — and the shape was not what anyone
would guess.

A real turn: 2.4 seconds of audio in, a 403-character answer out.

| | Cost | Share |
|---|---|---|
| Speech synthesis | 0.887c | **96%** |
| Transcription | 0.031c | 3% |
| Language model | 0.007c | 1% |

**Synthesis is almost the entire bill.** The language model — the part everyone
thinks of as the expensive bit — is a rounding error.

Two consequences, both counter-intuitive:

**Transcription bills a ten-second minimum per request.** A 2.4 second clip is
billed as ten. Trimming clips tighter helps accuracy and latency and saves
nothing whatsoever on cost.

**The obvious optimisations chase 3% of the bill.** Switching to a cheaper
transcription model cuts that line by 64% and the total by 2.1%. Whereas making
the agent less wordy — 403 characters down to 150 — cuts the total by **60%**,
because synthesis bills per character. Verbosity is the cost driver, and it is
a latency driver too, so that change wins twice.

This is the whole argument for measuring before optimising, in one table.

---

## Where it runs

Free tier: the browser on Vercel, the server on Render, transcription and the
model and speech behind APIs.

There is a lesson in the deployment too. Memory was tested carefully — 343 MB
peak against a 512 MB limit, 169 MB of headroom, comfortably fine. Then a
single turn took **104 seconds**.

The constraint was never memory. It was 0.1 vCPU. Anything computed on that box
ran 25 to 50 times slower; anything behind an API was unaffected. Local speech
synthesis went from 0.56 seconds to 29. The fix was to stop computing on that
box at all — synthesis moved to an API, and the audio conversion disappeared
once it turned out the transcriber accepts the browser's format directly.

Time to first audio: **28.9 seconds → 1.2 seconds.**

The general version of that lesson: careful measurement of the wrong resource
tells you nothing.

---

## How it gets better from here

The agent now generates its own evaluation data as a by-product of being used.

**Record a call.** Optional, off by default, never uploaded. Both voices are
captured on *separate* tracks — a mixed recording cannot be scored, because you
cannot tell whose voice you are evaluating, and the moments worth evaluating
are exactly the ones where both are talking.

**Download the bundle.** One zip: both audio tracks, the full diagnostic log, a
manifest, and a README explaining the contents.

**Import it.**

```bash
cd backend && npm run import:call -- ~/Downloads/voice-agent-<id>.zip
```

The log already knows when you spoke, what was transcribed, how any
interruption was classified and whether it was discarded. The importer joins
that to the audio and cuts one clip per utterance, labelled. No one listens to
a recording and types what they hear.

The join works because a clip's byte count appears on both the send and on its
transcript, so it holds even when events arrive out of order.

What comes out:

```json
{
  "clip": "clips/000-turn.webm",
  "label": "turn",
  "transcript": "Explain Software Engineering.",
  "transcriptVerified": false,
  "spokenMs": 1359,
  "audio": { "startSec": 8, "endSec": 9.96 }
}
```

The transcript is what the agent *heard*, not what was said. Correcting the
wrong ones is the only human step left, and it is editing rather than
transcribing.

---

## What is next, and what it should produce

### 1. The scorer

**Intent.** Read every labelled clip in the corpus, run it back through the
pipeline, and score what comes out.

**What it measures.** Whether "mhm" is correctly recognised as a backchannel
and a question as an interruption. Whether the silence filter rejects artefacts
without rejecting a real one-word answer — "no" and "yes" are real answers, and
rejecting them is the dangerous failure. How far transcription drifts from the
corrected text. Where the time actually goes.

**Expected outcome.** Claims become numbers. "Handles interruptions" becomes
"94% precision, 89% recall across 200 clips". Every bug already fixed becomes a
regression test, so it cannot come back quietly.

**Design decision worth keeping.** Two tiers. The deterministic parts —
classification, the artefact filter, sentence chunking, history truncation —
run on every commit, free and fast. The parts that call an API run on demand,
because they cost quota and can fail for reasons that have nothing to do with
the code.

### 2. A corpus worth scoring against

**Intent.** The current corpus is one clean turn. Nothing to discriminate
against.

**What it needs.** Deliberate "mhm"s. Real interruptions. One-word answers.
Coughs and chair scrapes. Background noise. A different microphone.

**Expected outcome.** Numbers that mean something. A classifier scoring 100% on
a corpus with nothing hard in it tells you nothing at all.

**How to get there.** Record a handful of calls and deliberately misbehave in
them. Generate the bulk synthetically with speech synthesis, where the input
text is ground truth for free — real recordings keep the synthetic ones honest.

### 3. Spending the cost finding

**Intent.** The measurement says verbosity is 96% of the bill. Act on it.

**What changes.** One line in the agent's instructions: two or three sentences
becomes one or two.

**Expected outcome.** Roughly 60% off the cost per turn and a shorter wait
before the agent stops talking. Worth doing *after* the scorer exists, so the
answer-quality cost of being terser is measured rather than assumed.

### 4. A recording in the README

**Intent.** The engineering is invisible. Someone opening the link sees a voice
chatbot, and nothing in the first thirty seconds says otherwise.

**What it needs.** A short screen recording of one interruption mid-sentence.

**Expected outcome.** The thing this project is actually about, visible in three
seconds rather than three paragraphs.

---

## The through-line

Three things, stated once:

**Build the diagnostics before the features.** The exportable log arrived
halfway through. Every bug after it took minutes; every bug before it took
days.

**Measure the constraint you actually have.** Memory was tested thoroughly and
the answer was irrelevant, because the constraint was CPU.

**The model is the easy part.** It is the only component that never needed
debugging.
