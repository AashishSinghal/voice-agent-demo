/**
 * What went wrong, and what fixed it.
 *
 * Shaped as problem / cause / fix on purpose: that is how each of these was
 * actually worked through, and it is the shape a case study needs. The panel
 * renders it, and `scripts/export-changelog.ts` turns the same data into
 * markdown, so there is one source rather than a UI copy drifting from a
 * written-up copy.
 *
 * Every figure here came from a measurement or a diagnostic log, not an
 * estimate.
 */

export type EntryKind = 'bug' | 'capability' | 'insight';

export interface Metric {
  label: string;
  before?: string;
  after: string;
}

export interface ChangeEntry {
  date: string;
  title: string;
  kind: EntryKind;
  /** What you would have noticed as a caller. */
  problem: string;
  /** Why it happened. Omitted where the entry is a capability, not a fault. */
  cause?: string;
  fix: string;
  metrics?: Metric[];
  /** A few real lines, where the log is more convincing than the prose. */
  log?: string;
}

export const CHANGELOG: ChangeEntry[] = [
  {
    date: '2026-10-14',
    title: 'Interrupting stopped the sound but not the turn',
    kind: 'bug',
    problem:
      'The new question appeared on screen, but the old answer kept playing to the end. The agent only moved on afterwards, so the interruption felt like it landed after the turn instead of in the middle of it.',
    cause:
      'Two faults stacked. Speech that began while the agent was still "thinking" was not armed as a barge-in, and the agent\'s first audio then landed on top of the caller. It was sent as an ordinary turn, so the server aborted the old generation but sent the browser nothing. The browser did have a rule that a new turn supersedes the old one, but it only released chunks still waiting in the queue; the chunk already playing had left the queue and survived.',
    fix:
      'The server now tells the browser to drop the old answer the moment the new transcript arrives, and records only the sentences that finished playing. The browser also releases whatever chunk belongs to an older turn, and audio that arrives while the caller is already talking is held and treated as an interruption from its first frame.',
    metrics: [
      { label: 'old answer kept playing after being replaced', before: '12.4 s', after: 'dropped at the transcript' },
    ],
    log: `17.52s server  ✋ Aborting turn 6 (new caller turn)
22.65s audio   chunk play start {"turnId":6,"index":1}
25.62s audio   chunk queued {"turnId":7,"index":0,"playing":true}`,
  },
  {
    date: '2026-10-14',
    title: '"Stop" was too short to hear, and was answered as a question',
    kind: 'bug',
    problem:
      'Saying "stop" while the agent talked did nothing, and when an interruption did register, "stop" was answered with a fresh paragraph instead of silence.',
    cause:
      'Speech needed 250 ms of sustained sound before it counted, and the word is shorter than that: the log shows one loud sample, then the clip was discarded for holding under 300 ms of speech. Separately, every interruption started a new turn, so even a heard "stop" became a question to answer.',
    fix:
      'While the agent is speaking, speech counts after 120 ms and a clip needs 150 ms, because a false alarm only costs a brief pause that the server resumes. A halt class ("stop", "that\'s enough", "be quiet", "hold on") ends the turn and starts no new one. "Don\'t stop" is the opposite and resumes, and "bus stop" is not a command.',
    log: `26.55s vad    level {"rms":0.1146,"floor":0.0053,"speechAt":0.016}
27.30s audio  recording discarded {"bytes":165482}`,
  },
  {
    date: '2026-09-26',
    title: 'Calls can be recorded as two separate tracks',
    kind: 'capability',
    problem:
      'Evaluating the agent needs labelled audio, and there was no way to capture a real call.',
    fix: 'Optional recording captures the caller and the agent as separate tracks, aligned with each other and with the diagnostic log. A mixed file cannot be scored — you cannot tell which voice you are evaluating, and the moments worth evaluating are the ones where both are talking. Off by default, never uploaded.',
  },
  {
    date: '2026-09-25',
    title: 'Speech synthesis turned out to be 96% of the bill',
    kind: 'insight',
    problem:
      'The project had no cost visibility, so optimisation would have been guesswork.',
    fix: 'Every turn is now priced at on-demand rates. The result inverted the plan: the instinctive optimisations — a cheaper transcription model, tighter audio clips — chase 3% of the bill. Synthesis bills per character, so how much the agent says is the cost driver, and trimming verbosity cuts latency at the same time.',
    metrics: [
      { label: 'Synthesis share of a turn', after: '96.0%' },
      { label: 'Cheaper transcription model', after: '2.1% off the total' },
      { label: 'Halving the answer length', after: '60% off the total' },
    ],
  },
  {
    date: '2026-09-25',
    title: 'A watchdog cut the agent off mid-sentence',
    kind: 'bug',
    problem: 'A perfectly healthy 26-second answer was stopped halfway through.',
    cause:
      'A watchdog recovers calls that stop making progress after 20 seconds. The browser sends nothing at all while it plays audio, so a long answer and a wedged call looked identical from the server.',
    fix: 'The client now heartbeats every four seconds while audio is playing. Speaking also gets its own longer budget, so if heartbeats ever do stop the agent is cut off late rather than mid-sentence.',
  },
  {
    date: '2026-09-25',
    title: 'The free tier was never short of memory',
    kind: 'insight',
    problem: 'A single turn took 104 seconds on the deployed instance.',
    cause:
      'I had stress-tested memory carefully and it passed with 169 MB of headroom. The constraint was 0.1 vCPU, which I never measured. Anything computed on the box ran 25 to 50 times slower; anything behind an API was unaffected.',
    fix: 'Stop computing on that box. Synthesis moved to a hosted API, and the audio transcode disappeared once I checked that the transcriber accepts the browser format directly.',
    metrics: [
      { label: 'Time to first audio', before: '28,873 ms', after: '1,233 ms' },
      { label: 'Audio preparation', before: '5,200 ms', after: '562 ms' },
      { label: 'Container image', before: '1.48 GB', after: '253 MB' },
    ],
  },
  {
    date: '2026-09-22',
    title: 'Six recorders were running at once',
    kind: 'bug',
    problem:
      'Speech kept going missing, and the transcriber kept returning text for audio that contained nothing.',
    cause:
      'MediaRecorder.onstop is asynchronous. Clearing the recorder reference unconditionally orphaned the replacement that had already started, so it captured forever and the next cycle created another. The clip actually sent was usually a fresh, nearly empty buffer.',
    fix: 'The reference is cleared only if it still points at that recorder, and discard intent moved to a per-recording object that a restart cannot reset.',
    log: `119.93s recording ready {"bytes":1756582}
119.93s recording ready {"bytes":1407822}
119.93s recording ready {"bytes":1043640}
119.93s recording ready {"bytes":792448}
119.93s recording ready {"bytes":451418}
119.93s recording ready {"bytes":116216}`,
  },
  {
    date: '2026-09-22',
    title: 'The transcriber answered questions nobody asked',
    kind: 'bug',
    problem: 'The agent kept replying to "Thank you." when nothing had been said.',
    cause:
      'Whisper is trained on subtitled video. Handed a few seconds of room tone it does not return an empty string, it returns caption boilerplate — and those became real conversational turns.',
    fix: 'The client will not send a clip containing less than 300 ms of audible speech, and the server rejects the known artefacts on short clips. Someone genuinely saying thank you mid-sentence is untouched.',
  },
  {
    date: '2026-09-22',
    title: 'The first word of every sentence was missing',
    kind: 'bug',
    problem: '"Explain software engineering" arrived as "engineering".',
    cause:
      'Recording started when speech was detected. Detection needs about 250 ms of sustained sound, and nobody starts a sentence at full volume — in one recording the microphone started 640 ms after I did.',
    fix: 'The microphone records for the whole call, and the server trims back to 700 ms before the detected onset using a stream copy, which does no signal processing.',
  },
  {
    date: '2026-09-22',
    title: 'The agent only heard me if I shouted',
    kind: 'bug',
    problem: 'Normal speech was ignored. Shouting registered.',
    cause:
      'Loudness was measured as the mean of frequency-bin data, which is dominated by near-silent high bins and reads about 5 to 20 even for loud speech. The threshold was 45 — an unreachable number rather than a bad guess.',
    fix: 'Time-domain RMS instead, with thresholds derived from the room rather than hardcoded. The noise floor is estimated from a low percentile of recent frames, so it survives someone talking through the calibration.',
  },
  {
    date: '2026-09-22',
    title: 'Every bug after this one took minutes instead of days',
    kind: 'insight',
    problem:
      'A voice agent fails in ways a screenshot cannot show: a threshold never crossed, an event arriving out of order, audio sent but never transcribed.',
    fix: 'One exportable timeline holding client events, socket traffic in both directions, the microphone level over time, and every line the server prints. Console output is bridged rather than routed through a logger, so output from dependencies is captured too.',
  },
  {
    date: '2026-09-22',
    title: 'The agent remembered saying things nobody heard',
    kind: 'bug',
    problem:
      'After an interruption the agent referred back to sentences that had never been spoken aloud.',
    cause:
      'When you interrupt, the model has usually generated more than it managed to say. The whole generated response was going into the conversation history.',
    fix: 'History records only the sentences that finished playing, flagged as interrupted. What it never got to say is kept separately, so you can ask it to carry on and it can.',
  },
  {
    date: '2026-09-22',
    title: '"mhm" no longer stops the agent',
    kind: 'capability',
    problem:
      'Any sound over the agent cancelled its answer, including acknowledgements.',
    fix: 'Playback pauses rather than cancelling. The interruption is transcribed, classified, and either resumed from the exact pause point or committed. The classifier is a set lookup, not a model call — it sits on the critical path between someone speaking and the agent reacting.',
    metrics: [
      { label: 'Agent goes quiet on interrupt', after: '~250 ms' },
      { label: 'Agent decides what to do', after: '~1 s' },
    ],
  },
  {
    date: '2026-09-22',
    title: 'Replies start before they are finished',
    kind: 'capability',
    problem:
      'Nothing was heard until the whole response had been generated and synthesised.',
    fix: 'Tokens are buffered into complete sentences and each is synthesised as it lands, so the first sentence plays while the rest is still being written.',
  },
];
