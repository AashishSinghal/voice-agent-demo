/**
 * A secret this browser keeps to prove which connected accounts are its own.
 *
 * Deliberately separate from the session id: the session id is in the resume
 * link and may be shared, this one never leaves the browser except in the
 * socket handshake. Losing it (clearing site data) just means reconnecting.
 */
const STORAGE_KEY = 'va-owner-key';

let fallback: string | null = null;

function fresh(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getOwnerKey(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && /^[0-9a-f]{64}$/.test(stored)) return stored;
    const made = fresh();
    localStorage.setItem(STORAGE_KEY, made);
    return made;
  } catch {
    // Storage blocked (private mode): lasts until the page closes.
    return (fallback ??= fresh());
  }
}
