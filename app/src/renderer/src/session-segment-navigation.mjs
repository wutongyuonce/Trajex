export function createSessionSegments(roundIndexes, capacity) {
  const rounds = [...new Set(roundIndexes)].sort((left, right) => left - right);
  const count = Math.min(rounds.length, Math.max(1, Math.floor(capacity)));
  if (count === 0) return [];

  const baseSize = Math.floor(rounds.length / count);
  const extra = rounds.length % count;
  let start = 0;
  return Array.from({ length: count }, (_, index) => {
    const size = baseSize + (index < extra ? 1 : 0);
    const end = start + size - 1;
    const segment = {
      startRound: start + 1,
      endRound: end + 1,
      targetIndex: rounds[start],
      endIndex: rounds[end],
    };
    start = end + 1;
    return segment;
  });
}

export function findCurrentSessionSegment(segments, timelineIndex) {
  if (!segments.length) return -1;
  const current = segments.findIndex(segment => timelineIndex <= segment.endIndex);
  return current < 0 ? segments.length - 1 : current;
}
