import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halloweenAt } from '../src/event-calendar.js';
test('co-op uses the upstream Madrid event boundaries, including both Korean calendar edges', () => {
  for (const [date, on] of [
    ['2026-10-29T22:59:59.999Z', false], ['2026-10-29T23:00:00Z', true],
    ['2026-11-01T22:59:59.999Z', true], ['2026-11-01T23:00:00Z', true], ['2026-11-02T22:59:59.999Z', true], ['2026-11-02T23:00:00Z', false],
    ['2027-10-29T21:59:59.999Z', false], ['2027-10-29T22:00:00Z', true],
    ['2027-11-01T23:00:00Z', true], ['2027-11-02T23:00:00Z', false]
  ]) assert.equal(halloweenAt(Date.parse(date)), on, date);
});
