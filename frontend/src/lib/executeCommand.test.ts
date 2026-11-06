import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeCommand, type CommandPorts } from './executeCommand.ts';

function fakePorts(held: { chunk?: string; clip?: string } = {}) {
  const calls: string[] = [];
  const log = (name: string) => (...args: unknown[]) => calls.push(`${name}:${JSON.stringify(args)}`);
  const ports: CommandPorts<string, string> = {
    heldChunk: () => held.chunk ?? null,
    heldClip: () => held.clip ?? null,
    playback: { enqueue: log('enqueue'), pause: log('pause'), resume: log('resume'), stop: log('stop'), resetCounter: log('reset') },
    recorder: { stop: log('recStop'), discard: log('recDiscard') },
    server: { sendAudio: log('send'), notifyBarge: log('barge'), cancelBarge: log('cancel') },
    ui: { setUserSpeaking: log('speaking'), setThinking: log('thinking'), startTimeline: log('tlStart'), markTimeline: log('tlMark') },
    log: { trace: log('trace'), clipDropped: log('dropped') },
  };
  return { ports, calls };
}

const SEND = { duringPlayback: false, spokenChunks: 0, trimStartMs: 0, spokenMs: 400, clipMs: 900 };

test('queuing audio uses the held chunk and the hold flag', () => {
  const { ports, calls } = fakePorts({ chunk: 'c' });
  executeCommand({ type: 'enqueueAudio', hold: true }, ports);
  assert.deepEqual(calls, ['enqueue:["c",{"startPaused":true}]']);
});

test('nothing is queued or sent when nothing is held, rather than reusing something stale', () => {
  const { ports, calls } = fakePorts();
  executeCommand({ type: 'enqueueAudio', hold: false }, ports);
  executeCommand({ type: 'sendClip', send: SEND }, ports);
  assert.deepEqual(calls, []);
});

test('sending passes the held clip with the module\'s metadata', () => {
  const { ports, calls } = fakePorts({ clip: 'r' });
  executeCommand({ type: 'sendClip', send: SEND }, ports);
  assert.deepEqual(calls, [`send:["r",${JSON.stringify(SEND)}]`]);
});

test('a dropped clip is reported with whatever was held', () => {
  const { ports, calls } = fakePorts({ clip: 'r' });
  executeCommand({ type: 'dropClip', reason: 'too short' }, ports);
  assert.deepEqual(calls, ['dropped:["too short","r"]']);
});

test('a timeline start carries its backdate; a mark does not', () => {
  const { ports, calls } = fakePorts();
  executeCommand({ type: 'timeline', op: 'start', kind: 'turn', backdateMs: 900 }, ports);
  executeCommand({ type: 'timeline', op: 'mark', label: 'x' }, ports);
  assert.deepEqual(calls, ['tlStart:["turn",900]', 'tlMark:["x"]']);
});

test('barge commands reach the server port with their arguments', () => {
  const { ports, calls } = fakePorts();
  executeCommand({ type: 'notifyBarge', turnId: 3, chunksPlayed: 2 }, ports);
  executeCommand({ type: 'cancelBarge', reason: 'noise' }, ports);
  assert.deepEqual(calls, ['barge:[3,2]', 'cancel:["noise"]']);
});
