/**
 * Carries out what the turn-taking module asks for.
 *
 * `step()` only returns commands; something has to touch the speaker, the
 * recorder and the socket. That used to be a switch inside VoiceAgent.tsx that
 * was rebuilt every render and read two side-channel refs, so a stale ref could
 * send the wrong clip with no test able to see it. It lives here, against a set
 * of ports, so the page and the offline call simulation run the same code.
 *
 * `Chunk` and `Clip` are what the page holds between an event arriving and the
 * command that uses it (the audio chunk to queue, the recording to send).
 */

import type { TimelineKind } from '../stores/useBotStateStore';
import type { TurnTakingCommand } from './turnTaking.ts';

export interface CommandPorts<Chunk, Clip> {
  /** The chunk that arrived with the event being handled, if any. */
  heldChunk(): Chunk | null;
  /** The recording that finished most recently, if any. */
  heldClip(): Clip | null;
  playback: {
    enqueue(chunk: Chunk, options: { startPaused: boolean }): void;
    pause(): void;
    resume(): void;
    stop(): void;
    resetCounter(): void;
  };
  recorder: { stop(): void; discard(): void };
  server: {
    sendAudio(clip: Clip, send: Extract<TurnTakingCommand, { type: 'sendClip' }>['send']): void;
    notifyBarge(turnId: number, chunksPlayed: number): void;
    cancelBarge(reason: string): void;
  };
  ui: {
    setUserSpeaking(value: boolean): void;
    setThinking(reason: string): void;
    startTimeline(kind: TimelineKind, backdateMs?: number): void;
    markTimeline(label: string): void;
  };
  log: {
    trace(label: string, detail?: string): void;
    clipDropped(reason: string, clip: Clip | null): void;
  };
}

export function executeCommand<Chunk, Clip>(command: TurnTakingCommand, ports: CommandPorts<Chunk, Clip>): void {
  switch (command.type) {
    case 'enqueueAudio': {
      const chunk = ports.heldChunk();
      if (chunk) ports.playback.enqueue(chunk, { startPaused: command.hold });
      break;
    }
    case 'pausePlayback':
      ports.playback.pause();
      break;
    case 'resumePlayback':
      ports.playback.resume();
      break;
    case 'stopPlayback':
      ports.playback.stop();
      break;
    case 'resetPlaybackCounter':
      ports.playback.resetCounter();
      break;
    case 'notifyBarge':
      ports.server.notifyBarge(command.turnId, command.chunksPlayed);
      break;
    case 'cancelBarge':
      ports.server.cancelBarge(command.reason);
      break;
    case 'stopRecording':
      ports.recorder.stop();
      break;
    case 'discardRecording':
      ports.recorder.discard();
      break;
    case 'sendClip': {
      const clip = ports.heldClip();
      if (clip) ports.server.sendAudio(clip, command.send);
      break;
    }
    case 'dropClip':
      ports.log.clipDropped(command.reason, ports.heldClip());
      break;
    case 'setUserSpeaking':
      ports.ui.setUserSpeaking(command.value);
      break;
    case 'setThinking':
      ports.ui.setThinking(command.reason);
      break;
    case 'trace':
      ports.log.trace(command.label, command.detail);
      break;
    case 'timeline':
      if (command.op === 'start') ports.ui.startTimeline(command.kind, command.backdateMs);
      else ports.ui.markTimeline(command.label);
      break;
  }
}
