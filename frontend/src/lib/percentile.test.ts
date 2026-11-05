import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile } from './percentile.ts';

test('P50 and P95 by nearest rank, not the mean', () => {
  const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
  assert.equal(percentile(samples, 0.5), 1000);
  assert.equal(percentile(samples, 0.95), 1900);
  assert.equal(percentile([700], 0.95), 700);
  assert.equal(percentile([], 0.5), null);
});
