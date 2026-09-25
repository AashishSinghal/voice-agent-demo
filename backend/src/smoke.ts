import { Conversation } from './services/conversation.js';
import { classifyUtterance, looksHallucinated } from './services/backchannel.js';
import { installLogBridge, subscribeToLogs, type LogLine } from './services/logBridge.js';
import { explainGroqTtsFailure } from './services/ttsService.js';
import Groq from 'groq-sdk';
import * as cost from './services/cost.js';
import { parseCall } from './eval/parseDiagnostics.js';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

console.log('--- backchannel classification ---');
for (const [text, kind] of [
  ['mhm', 'backchannel'],
  ['yeah', 'backchannel'],
  ['okay!', 'backchannel'],
  ['uh-huh', 'backchannel'],
  ['', 'backchannel'],
  ['go on', 'resume'],
  ['keep going', 'resume'],
  ['wait, which transfer?', 'interruption'],
  ['no', 'interruption'],
  ['actually can you stop', 'interruption'],
  ['what about the fees', 'interruption'],
] as const) {
  check(`"${text}" -> ${kind}`, classifyUtterance(text).kind, kind);
}

console.log('\n--- interruption truncates history to what was heard ---');
const c = new Conversation();
c.addUserTurn('tell me about my transfer');
c.trackChunk(1, 'Your transfer is on its way.');
c.trackChunk(1, 'It should arrive within two days.');
c.trackChunk(1, 'You will get an email when it lands.');

// caller cut in after hearing only the first sentence
const spoken = c.commitInterrupted(1, 1);
check('spoken text', spoken, 'Your transfer is on its way.');

const h = c.history();
check('history length', h.length, 2);
check('assistant content is only what was heard', h[1].content, 'Your transfer is on its way.');
check('marked interrupted', h[1].interrupted, true);
check(
  'unspoken remainder kept',
  h[1].unspoken,
  'It should arrive within two days. You will get an email when it lands.'
);
check('lastUnspoken for resume', c.lastUnspoken(), 'It should arrive within two days. You will get an email when it lands.');

console.log('\n--- interrupted before hearing anything ---');
const c2 = new Conversation();
c2.addUserTurn('hello');
c2.trackChunk(1, 'Let me look that up for you.');
const spoken2 = c2.commitInterrupted(1, 0);
check('nothing spoken', spoken2, '');
check('no phantom assistant turn', c2.history().length, 1);

console.log('\n--- uninterrupted turn commits in full ---');
const c3 = new Conversation();
c3.addUserTurn('hi');
c3.trackChunk(1, 'Hello there.');
c3.commitComplete(1, 'Hello there. How can I help?');
check('full text committed', c3.history()[1].content, 'Hello there. How can I help?');
check('not flagged interrupted', c3.history()[1].interrupted, undefined);
check('no stale unspoken', c3.lastUnspoken(), null);

console.log('\n--- abandoned turn is salvaged, not lost ---');
const c4 = new Conversation();
c4.addUserTurn('explain closures');
c4.trackChunk(5, 'A closure is a function bundled with its scope.');
c4.trackChunk(5, 'It remembers the variables around it.');
check('has pending', c4.hasPending(), true);
const salvaged = c4.commitPendingAsInterrupted();
check(
  'salvaged text',
  salvaged,
  'A closure is a function bundled with its scope. It remembers the variables around it.'
);
check('recorded in history', c4.history().length, 2);
check('flagged interrupted', c4.history()[1].interrupted, true);
check('pending cleared', c4.hasPending(), false);
check('salvaging nothing is safe', new Conversation().commitPendingAsInterrupted(), '');

console.log('\n--- whisper silence artefacts are rejected ---');
for (const [text, spokenMs, expected] of [
  ['Thank you.', 200, true],
  ['thank you', 0, true],
  ['Thanks for watching!', 300, true],
  ['you', 150, true],
  ['', 0, true],
  // a long enough utterance is taken at face value, even if it matches
  ['Thank you.', 2000, false],
  // real speech is never rejected
  ['explain software engineering', 900, false],
  ['what about closures', 400, false],
] as const) {
  check(`"${text}" @${spokenMs}ms -> ${expected ? 'reject' : 'keep'}`,
    looksHallucinated(text, spokenMs), expected);
}

console.log('\n--- server logs are mirrored to subscribers ---');
installLogBridge();

const captured: LogLine[] = [];
const unsubscribe = subscribeToLogs((line) => captured.push(line));

console.log('plain line', { a: 1 });
console.warn('a warning');
console.error(new Error('boom'));

check('forwarded three lines', captured.length, 3);
check('renders objects', captured[0].text, 'plain line {"a":1}');
check('keeps the level', captured[1].level, 'warn');
check('renders errors readably', captured[2].text, 'Error: boom');

// A subscriber that logs must not recurse.
let reentrant = 0;
const unsubscribeNoisy = subscribeToLogs(() => {
  reentrant += 1;
  if (reentrant < 5) console.log('from inside a subscriber');
});
console.log('trigger');
check('no runaway recursion', reentrant, 1);

unsubscribeNoisy();
unsubscribe();

const afterUnsubscribe = captured.length;
console.log('should not be captured');
check('unsubscribe works', captured.length, afterUnsubscribe);

console.log('\n--- groq tts failures explain themselves ---');
const { APIError } = Groq as unknown as { APIError: { generate: (s: number, b: unknown, m: string, h: unknown) => Error } };
const apiError = (status: number, body: unknown) => APIError.generate(status, body, 'msg', {});
const MODEL = 'canopylabs/orpheus-v1-english';

for (const [label, err, fragment] of [
  [
    'terms required',
    apiError(400, { error: { message: 'x', type: 'invalid_request_error', code: 'model_terms_required' } }),
    'terms accepted',
  ],
  ['rate limited', apiError(429, { error: { message: 'slow down' } }), 'rate limit'],
  ['bad key', apiError(401, { error: { message: 'nope' } }), 'rejected the API key'],
] as const) {
  const explained = explainGroqTtsFailure(err, MODEL);
  check(`${label} -> mentions "${fragment}"`, explained.message.includes(fragment), true);
}

// An abort is not a failure to explain; it must pass straight through.
const aborted = new DOMException('Synthesis aborted', 'AbortError');
check('abort passes through untouched', explainGroqTtsFailure(aborted, MODEL) === aborted, true);

console.log('\n--- cost model ---');

// Transcription bills a ten-second minimum per request.
check('short clip billed at the minimum', cost.billedAudioSeconds(2.4), 10);
check('long clip billed at its real length', cost.billedAudioSeconds(24), 24);
check(
  'a 10s clip costs the hourly rate / 360',
  Number(cost.sttCost(10).toFixed(8)),
  Number((0.111 / 360).toFixed(8))
);
check('trimming below the minimum saves nothing', cost.sttCost(1) === cost.sttCost(9), true);

// Per-million arithmetic.
check(
  'llm priced per million tokens',
  Number(cost.llmCost({ promptTokens: 1_000_000, completionTokens: 0 }).toFixed(6)),
  0.075
);
check(
  'tts priced per million characters',
  Number(cost.ttsCost(1_000_000).toFixed(6)),
  22
);

// The finding this whole exercise exists to surface.
const turn = cost.turnCost({
  audioSeconds: 2.4,
  usage: { promptTokens: 600, completionTokens: 67 },
  spokenCharacters: 403,
});
check('synthesis dominates a realistic turn', turn.ttsUsd / turn.totalUsd > 0.9, true);
check('language model is a rounding error', turn.llmUsd / turn.totalUsd < 0.02, true);

// Accumulation across a call.
const twice = cost.addCost(turn, turn);
check('session total accumulates', Number(twice.totalUsd.toFixed(8)), Number((turn.totalUsd * 2).toFixed(8)));
check('session characters accumulate', twice.detail.spokenCharacters, 806);
check('first turn seeds the session', cost.addCost(null, turn).totalUsd, turn.totalUsd);

console.log('\n--- diagnostics parse into labelled utterances ---');

// Shaped exactly like an exported log, including the lines that must be ignored.
const FIXTURE = [
  '   0.33s audio      conversation recording started {"agentTrack":true}',
  '   2.91s vad        speech end {"silenceWindowMs":900}',
  '   8.63s vad        speech start {"rms":0.057,"threshold":0.0161,"floor":0.0054}',
  '  10.89s vad        speech end {"silenceWindowMs":900}',
  '  10.89s socket-out audio:input {"bytes":168380,"duringPlayback":false,"spokenMs":1359,"clipMs":2959,"trimStartMs":7594}',
  '  11.10s server     [abc123] -> response:text:delta turnId=2 token="Software"',
  '  12.40s server     · transcript {"ms":789,"text":"Explain Software Engineering.","bytes":168380}',
  '  20.10s vad        speech start {"rms":0.04,"threshold":0.016,"floor":0.005}',
  '  21.00s vad        speech end {"silenceWindowMs":450}',
  '  21.00s socket-out audio:input {"bytes":61154,"duringPlayback":true,"spokenMs":1350,"clipMs":1800,"trimStartMs":1305}',
  '  22.00s server     · transcript {"ms":600,"text":"Thank you.","bytes":61154}',
  '  22.01s server     · discarded over-speech {"text":"Thank you.","spokenMs":1350}',
  '  22.02s server     · classification {"kind":"backchannel","normalised":"","spokenChunks":1}',
  '  57.49s audio      conversation recording stopped {"callerBytes":918293,"durationMs":57162}',
].join('\n');

const parsed = parseCall(FIXTURE);

check('recording start located', parsed.recordingStartedAt, 0.33);
check('recording duration located', parsed.recordingDurationMs, 57162);
check('both sends found', parsed.utterances.length, 2);

const [reply, overSpeech] = parsed.utterances;

check('transcript joined by byte count', reply.transcript, 'Explain Software Engineering.');
check('transcription time captured', reply.sttMs, 789);
check('normal turn not flagged as over-speech', reply.overSpeech, false);
// speech 8.63 -> 10.89 minus the 900ms window, both padded, relative to 0.33
check('clip start derived from speech onset', Number(reply.audio!.startSec.toFixed(2)), 8.0);
check('clip end excludes the silence window', Number(reply.audio!.endSec.toFixed(2)), 9.96);

check('over-speech flagged', overSpeech.overSpeech, true);
check('classification attached', overSpeech.classification, 'backchannel');
check('discard recorded', overSpeech.discarded, true);
// speech ends 21.00, minus the 450ms window, minus the 0.33 recording start,
// plus 0.3 padding — a tighter window than the 900ms used for a normal turn.
check('a tighter window is respected', Number(overSpeech.audio!.endSec.toFixed(2)), 20.52);

// Trace lines carry no JSON payload and must not become events.
check('payload-less trace lines ignored', parsed.events.some((e) => e.name.includes('response:text:delta')), false);

// A silent stretch fires speech-end without a send; it must not invent an utterance.
check('unpaired speech-end ignored', parsed.utterances.every((u) => u.bytes > 0), true);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
