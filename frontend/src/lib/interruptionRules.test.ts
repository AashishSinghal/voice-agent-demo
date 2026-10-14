import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldBargeOnArrival, shouldReleaseCurrent } from './interruptionRules.ts';

test('the chunk already playing is released when a newer turn arrives', () => {
  // The regression from a real call: turn 6's last chunk was playing with an
  // empty queue when turn 7's first chunk arrived, and kept playing.
  assert.equal(
    shouldReleaseCurrent({ paused: false, droppedQueued: 0, playingTurn: 6, incomingTurn: 7 }),
    true
  );
});

test('a chunk of the same turn never cuts itself off', () => {
  assert.equal(
    shouldReleaseCurrent({ paused: false, droppedQueued: 0, playingTurn: 7, incomingTurn: 7 }),
    false
  );
});

test('nothing playing means nothing to release unless queued audio was dropped or paused', () => {
  assert.equal(
    shouldReleaseCurrent({ paused: false, droppedQueued: 0, playingTurn: null, incomingTurn: 7 }),
    false
  );
  assert.equal(
    shouldReleaseCurrent({ paused: false, droppedQueued: 2, playingTurn: null, incomingTurn: 7 }),
    true
  );
  assert.equal(
    shouldReleaseCurrent({ paused: true, droppedQueued: 0, playingTurn: null, incomingTurn: 7 }),
    true
  );
});

test('audio arriving into live speech is held as an interruption', () => {
  assert.equal(
    shouldBargeOnArrival({ callerSpeaking: true, alreadyBarging: false, callActive: true }),
    true
  );
});

test('it is not re-armed when already barging, silent, or the call is over', () => {
  assert.equal(
    shouldBargeOnArrival({ callerSpeaking: true, alreadyBarging: true, callActive: true }),
    false
  );
  assert.equal(
    shouldBargeOnArrival({ callerSpeaking: false, alreadyBarging: false, callActive: true }),
    false
  );
  assert.equal(
    shouldBargeOnArrival({ callerSpeaking: true, alreadyBarging: false, callActive: false }),
    false
  );
});
