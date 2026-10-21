import { Conversation } from './services/conversation.js';
import { classifyUtterance, looksHallucinated } from './services/backchannel.js';
import {
  installLogBridge,
  subscribeToLogs,
  subscribeToSessionLogs,
  runInSession,
  describeError,
  type LogLine,
} from './services/logBridge.js';
import { explainGroqTtsFailure } from './services/ttsService.js';
import {
  validateAudioInput,
  validateBarge,
  validatePlayback,
  plausibleClipMs,
} from './services/validate.js';
import {
  Limiter,
  DEFAULT_LIMITS,
  clientIp,
  limitsFromEnv,
  tokenMatches,
  trustProxyFromEnv,
} from './services/limits.js';
import { confidenceFromSegments, sttLanguage } from './services/whisperService.js';
import Groq from 'groq-sdk';
import * as cost from './services/cost.js';
import { resolveBargeCancel } from './services/bargeCancel.js';
import { reasoningParams } from './services/llmService.js';
import { parseCall } from './eval/parseDiagnostics.js';
import { SseParser, parseBrainEvent, brainHeaders } from './services/brainClient.js';

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
  ['stop', 'halt'],
  ['Stop!', 'halt'],
  ['stop talking', 'halt'],
  ['okay stop', 'halt'],
  ['please stop', 'halt'],
  ["that's enough", 'halt'],
  ['wait', 'halt'],
  ['hold on', 'halt'],
  ['could you please stop talking', 'halt'],
  ["don't stop", 'resume'],
  ['bus stop', 'interruption'],
  ['stop sign', 'interruption'],
  ['stop explaining that and tell me about caching', 'interruption'],
  ['what does the stop codon do', 'interruption'],
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

console.log('\n--- mirrored logs are per-session and scrubbed ---');
{
  const seenA: LogLine[] = [];
  const seenB: LogLine[] = [];
  const offA = subscribeToSessionLogs('A', (l) => seenA.push(l));
  const offB = subscribeToSessionLogs('B', (l) => seenB.push(l));

  console.log('outside any session');
  runInSession('A', () => console.log('transcript for A'));
  runInSession('B', () => console.log('transcript for B'));
  // Context must survive an await, since that is how real turns log.
  await runInSession('A', async () => {
    await new Promise((r) => setTimeout(r, 5));
    console.log('A after await');
  });

  check('A sees only its own lines', seenA.map((l) => l.text), ['transcript for A', 'A after await']);
  check('B sees only its own lines', seenB.map((l) => l.text), ['transcript for B']);

  process.env.GROQ_API_KEY = 'gsk_supersecretvalue1234567890';
  runInSession('A', () => {
    console.log('key is gsk_supersecretvalue1234567890');
    console.error({ headers: { authorization: 'Bearer abcdef1234567890' } });
  });
  check('key redacted from mirrored text', seenA[2].text.includes('supersecret'), false);
  check('auth header redacted', seenA[3].text.includes('abcdef1234'), false);
  check('describeError drops headers', describeError(Object.assign(new Error('bad'), {
    status: 401, headers: { authorization: 'Bearer zzzzzzzzzz' },
  })), 'Error (401): bad');
  delete process.env.GROQ_API_KEY;

  offA();
  runInSession('A', () => console.log('after unsubscribe'));
  check('session unsubscribe works', seenA.length, 4);
  offB();
}

console.log('\n--- socket payload validation ---');
{
  const clip = Buffer.alloc(40_000); // plausibly ~10s of opus
  const good = validateAudioInput({ audio: clip, trimStartMs: 700, spokenMs: 1200, clipMs: 5000, duringPlayback: true, spokenChunks: 2 });
  check('valid audio accepted', good.ok, true);
  if (good.ok) {
    check('numbers pass through', [good.value.trimStartMs, good.value.spokenMs, good.value.clipMs, good.value.spokenChunks], [700, 1200, 5000, 2]);
    check('ArrayBuffer is also accepted', validateAudioInput({ audio: new ArrayBuffer(100) }).ok, true);
  }

  for (const [label, payload] of [
    ['null payload', null],
    ['array payload', []],
    ['string payload', 'audio'],
    ['no audio', {}],
    ['audio as string', { audio: 'AAAA' }],
    ['audio as Uint8Array', { audio: new Uint8Array(10) }],
    ['audio as number array', { audio: [1, 2, 3] }],
    ['empty audio', { audio: Buffer.alloc(0) }],
    ['NaN trimStartMs', { audio: clip, trimStartMs: NaN }],
    ['Infinity clipMs', { audio: clip, clipMs: Infinity }],
    ['string spokenMs', { audio: clip, spokenMs: '500' }],
    ['non-boolean duringPlayback', { audio: clip, duringPlayback: 'yes' }],
  ] as const) {
    check(`rejects ${label}`, validateAudioInput(payload).ok, false);
  }
  check('rejects audio over the byte cap', validateAudioInput({ audio: Buffer.alloc(2000) }, 1000).ok, false);

  const wild = validateAudioInput({ audio: clip, trimStartMs: 9e9, clipMs: 9e9, spokenMs: -50, spokenChunks: 99999 });
  check('wild values are clamped, not rejected', wild.ok, true);
  if (wild.ok) {
    check('trimStartMs clamped to 30s', wild.value.trimStartMs, 30_000);
    check('clipMs bounded by byte size', wild.value.clipMs, plausibleClipMs(clip.length));
    check('negative spokenMs clamped to 0', wild.value.spokenMs, 0);
    check('spokenChunks clamped', wild.value.spokenChunks, 1000);
  }
  const spokenOverClip = validateAudioInput({ audio: clip, clipMs: 2000, spokenMs: 9000 });
  check('spokenMs cannot exceed the reported clip', spokenOverClip.ok && spokenOverClip.value.spokenMs, 2000);

  check('barge accepted', validateBarge({ turnId: 3, chunksPlayed: 2 }), { ok: true, value: { turnId: 3, chunksPlayed: 2 } });
  check('barge clamps chunksPlayed', validateBarge({ turnId: 3, chunksPlayed: -4 }).ok, true);
  for (const bad of [undefined, null, {}, { turnId: '3' }, { turnId: 1.5 }, { turnId: -1 }, { turnId: NaN }, { turnId: 3, chunksPlayed: 'x' }]) {
    check(`barge rejects ${JSON.stringify(bad)}`, validateBarge(bad).ok, false);
  }
  check('playback accepted', validatePlayback({ turnId: 7 }), { ok: true, value: { turnId: 7 } });
  check('playback rejects bad turnId', validatePlayback({ turnId: {} }).ok, false);
}

console.log('\n--- whisper confidence is measured ---');
check('no segments -> null, not a made-up number', confidenceFromSegments([]), null);
check('undefined segments -> null', confidenceFromSegments(undefined), null);
check('logprob 0 and no silence -> 1', confidenceFromSegments([{ avg_logprob: 0, no_speech_prob: 0 }]), 1);
check('likely-silence segment is penalised', confidenceFromSegments([{ avg_logprob: 0, no_speech_prob: 0.9 }]), 0.1);
{
  const mixed = confidenceFromSegments([{ avg_logprob: -0.1, no_speech_prob: 0.01 }, { avg_logprob: -1.5, no_speech_prob: 0.02 }]);
  check('mixed segments land in (0,1)', mixed !== null && mixed > 0.3 && mixed < 0.8, true);
}
check('STT language defaults to en', sttLanguage(), 'en');

console.log('\n--- abuse limits ---');
{
  let now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const cfg = { maxSocketsPerIp: 2, maxConnectsPerMinPerIp: 4, maxTurnsPerMinPerIp: 3, maxTurnsPerDay: 5 };
  const lim = new Limiter(cfg, () => now);

  const r1 = lim.open('1.1.1.1');
  lim.open('1.1.1.1');
  check('third concurrent socket refused', lim.checkConnect('1.1.1.1').allowed, false);
  check('another IP unaffected', lim.checkConnect('2.2.2.2').allowed, true);
  r1();
  r1(); // a duplicate release must not free a second slot
  check('slot freed after disconnect', lim.checkConnect('1.1.1.1').allowed, true);
  lim.open('1.1.1.1');
  check('double release did not over-free', lim.checkConnect('1.1.1.1').allowed, false);

  const lim2 = new Limiter(cfg, () => now);
  for (let i = 0; i < 4; i++) lim2.open('3.3.3.3')();
  check('connection rate limited', lim2.checkConnect('3.3.3.3').allowed, false);
  now += 61_000;
  check('connection window slides', lim2.checkConnect('3.3.3.3').allowed, true);

  const t = new Limiter(cfg, () => now);
  check('turns 1-3 allowed', [t.tryTurn('a').allowed, t.tryTurn('a').allowed, t.tryTurn('a').allowed], [true, true, true]);
  const refused = t.tryTurn('a');
  check('fourth turn in a minute refused', !refused.allowed && refused.scope, 'ip-turns');
  check('another IP still allowed', t.tryTurn('b').allowed, true);
  now += 61_000;
  check('per-minute window slides', t.tryTurn('a').allowed, true);
  check('turns so far today', t.turnsToday(), 5);
  const daily = t.tryTurn('c');
  check('daily cap refuses with a message', !daily.allowed && daily.scope === 'daily' && daily.message.length > 20, true);
  now += 13 * 3600_000; // past midnight UTC
  check('daily counter resets at UTC midnight', t.tryTurn('c').allowed, true);
  check('0 disables a limit', new Limiter({ ...cfg, maxTurnsPerDay: 0, maxTurnsPerMinPerIp: 0 }, () => now).tryTurn('z').allowed, true);

  const env = limitsFromEnv({ MAX_TURNS_PER_DAY: '12', MAX_SOCKETS_PER_IP: 'junk' } as NodeJS.ProcessEnv);
  check('limits read from env', [env.maxTurnsPerDay, env.maxSocketsPerIp], [12, DEFAULT_LIMITS.maxSocketsPerIp]);

  check('direct address when no proxy trusted', clientIp('::ffff:9.9.9.9', '6.6.6.6', 0), '9.9.9.9');
  check('spoofed XFF ignored without trust', clientIp('9.9.9.9', '6.6.6.6, 7.7.7.7', 0), '9.9.9.9');
  check('one trusted proxy takes the last hop', clientIp('10.0.0.1', '6.6.6.6, 7.7.7.7', 1), '7.7.7.7');
  check('two trusted proxies take the second from last', clientIp('10.0.0.1', '6.6.6.6, 7.7.7.7', 2), '6.6.6.6');
  check('missing header falls back to socket', clientIp('9.9.9.9', undefined, 1), '9.9.9.9');
  check('TRUST_PROXY=true is one hop', trustProxyFromEnv({ TRUST_PROXY: 'true' } as NodeJS.ProcessEnv), 1);
  check('TRUST_PROXY unset is none', trustProxyFromEnv({} as NodeJS.ProcessEnv), 0);
  check('token match', [tokenMatches('s3cret', 's3cret'), tokenMatches('s3cret', 'nope'), tokenMatches('s3cret', undefined)], [true, false, false]);
}

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

console.log('\n--- brain auth header ---');
check('no key, no header', brainHeaders({ accept: 'x' }, {}), { accept: 'x' });
check('a key is sent as a bearer token', brainHeaders({}, { BRAIN_API_KEY: 'k' }), { authorization: 'Bearer k' });
check('it is added alongside other headers', brainHeaders({ a: 'b' }, { BRAIN_API_KEY: 'k' }), { a: 'b', authorization: 'Bearer k' });
check('an empty key counts as unset', brainHeaders({}, { BRAIN_API_KEY: '' }), {});

console.log('\n--- groq reasoning effort ---');
{
  const saved = process.env.GROQ_REASONING_EFFORT;
  delete process.env.GROQ_REASONING_EFFORT;
  check('gpt-oss gets low reasoning by default', reasoningParams('openai/gpt-oss-20b'), { reasoning_effort: 'low' });
  check('other models are not sent the parameter', reasoningParams('llama-3.3-70b-versatile'), {});
  process.env.GROQ_REASONING_EFFORT = 'none';
  check('it can be turned off', reasoningParams('openai/gpt-oss-20b'), {});
  process.env.GROQ_REASONING_EFFORT = 'bogus';
  check('an invalid value falls back to low', reasoningParams('openai/gpt-oss-20b'), { reasoning_effort: 'low' });
  process.env.GROQ_REASONING_EFFORT = 'medium';
  check('it can be raised', reasoningParams('openai/gpt-oss-120b'), { reasoning_effort: 'medium' });
  if (saved === undefined) delete process.env.GROQ_REASONING_EFFORT;
  else process.env.GROQ_REASONING_EFFORT = saved;
}

console.log('\n--- barge cancelled ---');
check('paused with a turn in flight resumes speaking', resolveBargeCancel('paused', true), 'resume');
check('paused after the turn finished returns to listening', resolveBargeCancel('paused', false), 'listen');
for (const state of ['idle', 'listening', 'thinking', 'speaking', 'ended'] as const) {
  check(`a stale cancel while ${state} is ignored`, resolveBargeCancel(state, true), 'ignore');
}

console.log('\n--- brain event stream ---');
{
  const sse = new SseParser();
  // sse-starlette frames with \r\n, and a network chunk can split anywhere.
  const wire =
    'event: token\r\ndata: {"type":"token","text":"Hel"}\r\n\r\n' +
    ': keep-alive\r\n\r\n' +
    'event: token\r\ndata: {"type":"token","text":"lo"}\r\n\r\n';
  const events: Record<string, any>[] = [];
  for (let i = 0; i < wire.length; i += 7) events.push(...sse.push(wire.slice(i, i + 7)));
  check('events survive arbitrary chunk splits', events.map((e) => e.text), ['Hel', 'lo']);
  check('keep-alive comments are ignored', events.length, 2);
  check('a malformed block does not kill the stream', new SseParser().push('data: {oops\n\ndata: {"type":"token","text":"x"}\n\n').length, 1);
  check(
    'approval requests are mapped to camelCase',
    parseBrainEvent({ type: 'approval_required', call_id: 'c1', tool: 'delete_note', args: { note: 'x' }, prompt: 'Sure?' }),
    { type: 'approval_required', callId: 'c1', tool: 'delete_note', args: { note: 'x' }, prompt: 'Sure?' }
  );
  check('done carries awaitingApproval', (parseBrainEvent({ type: 'done', text: 'q', awaiting_approval: true }) as any).awaitingApproval, true);
  check('unknown event types are ignored', parseBrainEvent({ type: 'future_thing' }), null);
  check(
    'usage is mapped to camelCase',
    parseBrainEvent({ type: 'usage', tier: 'mid', model: 'm', prompt_tokens: 5, completion_tokens: 2, usd: 0.1, degraded_from: 'frontier' }),
    { type: 'usage', usage: { tier: 'mid', model: 'm', promptTokens: 5, completionTokens: 2, usd: 0.1, degradedFrom: 'frontier' } }
  );
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
