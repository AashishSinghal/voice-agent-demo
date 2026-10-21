/**
 * Small per-browser preferences.
 *
 * Storage can be unavailable (private windows, blocked site data) or throw, so
 * every access is guarded and the page behaves the same without it.
 */

const RECORD_KEY = 'voiceAgent.recordCall';

/**
 * Whether to record the call. On unless this visitor turned it off, and their
 * choice is remembered so it is not switched back on at the next visit.
 */
export function readRecordPreference(): boolean {
  try {
    return window.localStorage.getItem(RECORD_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeRecordPreference(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.removeItem(RECORD_KEY);
    else window.localStorage.setItem(RECORD_KEY, 'off');
  } catch {
    // Nothing to do: the choice simply will not persist.
  }
}
