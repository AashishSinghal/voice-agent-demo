/**
 * Trimming the export must not change what a call replays to. The hosted bundle
 * from 2026-11-05 is checked in sanitised form (replay.ts strips transcripts), so
 * the trimming is applied to the same lines and the module's commands compared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { replay, checkInvariants, type LogLine } from './replay.ts';
import { compactEntries } from './compactDiagnostics.ts';

for (const name of fs.readdirSync(new URL('./fixtures/', import.meta.url)).filter((n) => n.endsWith('.json'))) {
  test(`${name}: the trimmed log replays to the same commands`, () => {
    const { lines } = JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as { lines: LogLine[] };
    const trimmed = compactEntries(
      lines.map((l) => ({ t: l.t * 1000, source: l.source, event: l.name, data: l.data }))
    ).map((c): LogLine => ({ t: c.t / 1000, source: c.source, name: c.event, data: c.data ?? {} }));

    const full = replay(lines);
    const small = replay(trimmed);
    // Traces only note that an ignored "speech end" was ignored; they change nothing.
    const acts = (r: typeof full) =>
      r.commands.filter((c) => c.command.type !== 'trace').map((c) => [c.command.type, c.cause]);
    assert.deepEqual(acts(small), acts(full));
    assert.deepEqual(checkInvariants(small), []);
  });
}
