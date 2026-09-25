import { useCallback, useRef, useState } from 'react';
import { diag } from '../lib/diagnostics';

/**
 * Records both sides of a call as separate tracks.
 *
 * Two recorders rather than one mixed file: the caller on one, the agent on
 * the other. A mixed recording is useless as evaluation data — you cannot tell
 * which voice you are scoring, and the interesting moments are exactly the
 * ones where both are talking. Kept apart, the caller's track is ground truth
 * for transcription and endpointing, and the agent's track lines up with it.
 *
 * Both start together, so a shared timestamp aligns them and lines both up
 * against the diagnostic log.
 *
 * Nothing leaves the browser. The audio is held in memory for the duration of
 * the call and saved only when someone clicks save.
 */

interface Track {
  recorder: MediaRecorder;
  chunks: Blob[];
}

export interface ConversationRecording {
  callerBlob: Blob | null;
  agentBlob: Blob | null;
  startedAt: number;
  durationMs: number;
}

/**
 * Sidecar written beside the audio.
 *
 * MediaRecorder writes WebM as a live stream and never back-fills the Duration
 * element, so `ffprobe` reports no duration and tools cannot seek without
 * decoding the whole file. The recorder knows the length, so it writes it down
 * rather than leaving every consumer to recover it.
 */
export interface RecordingManifest {
  startedAt: string;
  durationMs: number;
  tracks: {
    role: 'caller' | 'agent';
    file: string;
    bytes: number;
    container: string;
  }[];
  note: string;
}

export function buildManifest(
  recording: ConversationRecording,
  names: { caller: string; agent: string }
): RecordingManifest {
  const tracks: RecordingManifest['tracks'] = [];

  if (recording.callerBlob) {
    tracks.push({
      role: 'caller',
      file: names.caller,
      bytes: recording.callerBlob.size,
      container: recording.callerBlob.type,
    });
  }
  if (recording.agentBlob) {
    tracks.push({
      role: 'agent',
      file: names.agent,
      bytes: recording.agentBlob.size,
      container: recording.agentBlob.type,
    });
  }

  return {
    startedAt: new Date(recording.startedAt).toISOString(),
    durationMs: recording.durationMs,
    tracks,
    note:
      'Both tracks start at the same instant, so they align with each other and ' +
      'with the diagnostic log from the same call. WebM written by MediaRecorder ' +
      'carries no duration in its header; use durationMs above, or remux with ' +
      '`ffmpeg -i in.webm -c copy out.webm` to write one.',
  };
}

const mimeType = () =>
  MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';

export const useConversationRecorder = () => {
  const callerRef = useRef<Track | null>(null);
  const agentRef = useRef<Track | null>(null);
  const startedAtRef = useRef(0);

  const [isRecording, setIsRecording] = useState(false);
  const [recording, setRecording] = useState<ConversationRecording | null>(null);

  const startTrack = (stream: MediaStream): Track | null => {
    try {
      const recorder = new MediaRecorder(stream, { mimeType: mimeType() });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      // A timeslice means data is flushed periodically rather than only on
      // stop, so a crashed tab still leaves something usable.
      recorder.start(2000);
      return { recorder, chunks };
    } catch (err) {
      diag.log('audio', 'conversation recorder failed to start', { message: String(err) });
      return null;
    }
  };

  const start = useCallback((callerStream: MediaStream, agentStream: MediaStream | null) => {
    if (callerRef.current) return;

    startedAtRef.current = Date.now();
    callerRef.current = startTrack(callerStream);
    agentRef.current = agentStream ? startTrack(agentStream) : null;

    if (callerRef.current) {
      setIsRecording(true);
      setRecording(null);
      diag.log('audio', 'conversation recording started', { agentTrack: !!agentRef.current });
    }
  }, []);

  const stop = useCallback(async (): Promise<ConversationRecording | null> => {
    const caller = callerRef.current;
    const agent = agentRef.current;
    if (!caller) return null;

    callerRef.current = null;
    agentRef.current = null;
    setIsRecording(false);

    const finish = (track: Track | null) =>
      new Promise<Blob | null>((resolve) => {
        if (!track || track.recorder.state === 'inactive') {
          resolve(track && track.chunks.length ? new Blob(track.chunks, { type: mimeType() }) : null);
          return;
        }
        track.recorder.onstop = () =>
          resolve(track.chunks.length ? new Blob(track.chunks, { type: mimeType() }) : null);
        track.recorder.stop();
      });

    const [callerBlob, agentBlob] = await Promise.all([finish(caller), finish(agent)]);

    const result: ConversationRecording = {
      callerBlob,
      agentBlob,
      startedAt: startedAtRef.current,
      durationMs: Date.now() - startedAtRef.current,
    };

    setRecording(result);
    diag.log('audio', 'conversation recording stopped', {
      callerBytes: callerBlob?.size ?? 0,
      agentBytes: agentBlob?.size ?? 0,
      durationMs: result.durationMs,
    });

    return result;
  }, []);

  return { start, stop, isRecording, recording };
};
