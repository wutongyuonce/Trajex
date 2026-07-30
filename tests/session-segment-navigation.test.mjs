import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionSegments,
  findCurrentSessionSegment,
} from '../app/src/renderer/src/session-segment-navigation.mjs';

test('session segments keep one marker per round when capacity permits', () => {
  assert.deepEqual(createSessionSegments([2, 5, 9], 8), [
    { startRound: 1, endRound: 1, targetIndex: 2, endIndex: 2 },
    { startRound: 2, endRound: 2, targetIndex: 5, endIndex: 5 },
    { startRound: 3, endRound: 3, targetIndex: 9, endIndex: 9 },
  ]);
});

test('session segments evenly compress continuous rounds without gaps', () => {
  const segments = createSessionSegments(Array.from({ length: 112 }, (_, index) => index), 40);

  assert.equal(segments.length, 40);
  assert.deepEqual(segments[0], { startRound: 1, endRound: 3, targetIndex: 0, endIndex: 2 });
  assert.deepEqual(segments.at(-1), { startRound: 111, endRound: 112, targetIndex: 110, endIndex: 111 });
  assert.equal(segments.reduce((total, segment) => total + segment.endRound - segment.startRound + 1, 0), 112);
});

test('current segment follows the round containing the viewport position', () => {
  const segments = createSessionSegments([3, 7, 11, 16], 2);

  assert.equal(findCurrentSessionSegment(segments, 0), 0);
  assert.equal(findCurrentSessionSegment(segments, 10), 1);
  assert.equal(findCurrentSessionSegment(segments, 99), 1);
});
