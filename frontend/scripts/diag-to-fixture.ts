/**
 * Turn a diagnostics bundle into a replay fixture.
 *
 *   node scripts/diag-to-fixture.ts <diagnostics.txt> <out.json> "<note>"
 *
 * Keeps only event names, timings and numbers. Transcripts and the server's own
 * output are dropped, so the result can be committed to a public repository.
 * Check the output before committing it anyway: it is yours to publish.
 */
import fs from 'node:fs';
import { parseDiagnostics, sanitise } from '../src/lib/replay.ts';

const [input, output, note = ''] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/diag-to-fixture.ts <diagnostics.txt> <out.json> "<note>"');
  process.exit(1);
}

const lines = sanitise(parseDiagnostics(fs.readFileSync(input, 'utf8')));
fs.writeFileSync(output, JSON.stringify({ note, lines }) + '\n');
console.log(`${lines.length} events written to ${output}`);
