import { Conversation } from './services/conversation.js';
import { classifyUtterance, looksHallucinated } from './services/backchannel.js';

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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
