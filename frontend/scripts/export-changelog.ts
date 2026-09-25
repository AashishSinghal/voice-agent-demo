/**
 * Turns the changelog into markdown for a written case study.
 *
 * The panel and the write-up share one source, so a fix recorded once cannot
 * drift between the two.
 *
 *   npx tsx scripts/export-changelog.ts            # print
 *   npx tsx scripts/export-changelog.ts out.md     # write
 */

import { writeFileSync } from 'node:fs';
import { CHANGELOG, type ChangeEntry } from '../src/data/changelog';

const HEADING: Record<ChangeEntry['kind'], string> = {
  bug: 'Fixed',
  capability: 'Added',
  insight: 'Learned',
};

function renderEntry(entry: ChangeEntry): string {
  const lines: string[] = [`## ${entry.title}`, ''];

  lines.push(`*${HEADING[entry.kind]} · ${entry.date}*`, '');
  lines.push(`**The problem.** ${entry.problem}`, '');

  if (entry.cause) lines.push(`**The cause.** ${entry.cause}`, '');
  lines.push(`**The fix.** ${entry.fix}`, '');

  if (entry.metrics?.length) {
    const hasBefore = entry.metrics.some((metric) => metric.before);
    lines.push(hasBefore ? '| | Before | After |' : '| | |');
    lines.push(hasBefore ? '| --- | --- | --- |' : '| --- | --- |');
    for (const metric of entry.metrics) {
      lines.push(
        hasBefore
          ? `| ${metric.label} | ${metric.before ?? '—'} | **${metric.after}** |`
          : `| ${metric.label} | **${metric.after}** |`
      );
    }
    lines.push('');
  }

  if (entry.log) lines.push('```', entry.log, '```', '');

  return lines.join('\n');
}

const counts = CHANGELOG.reduce<Record<string, number>>((acc, entry) => {
  acc[entry.kind] = (acc[entry.kind] ?? 0) + 1;
  return acc;
}, {});

const document = [
  '# Voice agent — what broke, and why',
  '',
  `${CHANGELOG.length} entries: ${counts.bug ?? 0} fixed, ${counts.capability ?? 0} added, ` +
    `${counts.insight ?? 0} learned. Every figure came from a measurement or a diagnostic log.`,
  '',
  ...CHANGELOG.map(renderEntry),
].join('\n');

const target = process.argv[2];
if (target) {
  writeFileSync(target, document);
  console.log(`wrote ${target} (${document.split('\n').length} lines)`);
} else {
  console.log(document);
}
