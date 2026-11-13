// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

import { decodeZstdFrames, scanZstdFrames, zstdDecoder } from '../packages/core/src/vendor/dsh-zstd.ts';

const fixture = new URL('./fixtures/deepseek/sessions/--dsh-v3--/v3-basic/session.v3.jsonl.zstd', import.meta.url);
const skipWithoutZstd = { skip: zstdDecoder() === null ? 'node:zlib zstd needs Node.js 22.15+' : false };

test('a real DSH compressed log scans into complete frames whose text concatenates to JSONL', skipWithoutZstd, () => {
  const buffer = readFileSync(fixture);
  const { frames, tornStart } = scanZstdFrames(buffer);
  assert.equal(tornStart, undefined);
  assert.ok(frames.length > 1, 'the header frame is followed by append-batch frames');
  assert.equal(frames.at(-1).end, buffer.length);
  const text = decodeZstdFrames(buffer, frames).map(frame => frame.toString('utf8')).join('');
  const lines = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].type, 'session');
  assert.equal(lines[0].version, 3);
  assert.equal(scanZstdFrames(buffer, 1).frames.length, 1, 'metadata readers can stop after the header frame');
});

test('a torn final frame is reported and excluded, never decoded', skipWithoutZstd, () => {
  const buffer = readFileSync(fixture);
  const { frames } = scanZstdFrames(buffer);
  for (const cut of [1, 3, 7]) {
    const torn = buffer.subarray(0, buffer.length - cut);
    const scan = scanZstdFrames(torn);
    assert.equal(scan.frames.length, frames.length - 1);
    assert.equal(scan.tornStart, frames.at(-1).start);
  }
});

test('skippable frames are stepped over and the unused header bit is ignored (RFC 8878)', skipWithoutZstd, () => {
  const data = zlib.zstdCompressSync(Buffer.from('{"type":"session"}\n'));
  const skippable = Buffer.alloc(8 + 3);
  skippable.writeUInt32LE(0x184D2A53, 0);
  skippable.writeUInt32LE(3, 4);
  const stream = Buffer.concat([skippable, data, data]);
  const { frames } = scanZstdFrames(stream);
  assert.deepEqual(frames.map(frame => frame.start), [skippable.length, skippable.length + data.length]);

  const unusedBit = Buffer.from(data);
  unusedBit[4] |= 0x10;
  assert.equal(scanZstdFrames(unusedBit).frames.length, 1);
  const reservedBit = Buffer.from(data);
  reservedBit[4] |= 0x08;
  assert.throws(() => scanZstdFrames(reservedBit), /reserved frame-header bit/);
  assert.throws(() => scanZstdFrames(Buffer.from('not zstd')), /invalid frame magic/);
});

test('a complete frame that fails its checksum rejects as corruption', skipWithoutZstd, () => {
  const data = zlib.zstdCompressSync(Buffer.from('{"type":"session"}\n'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  });
  const corrupt = Buffer.from(data);
  corrupt[corrupt.length - 1] ^= 0xff;
  const { frames } = scanZstdFrames(corrupt);
  assert.throws(() => decodeZstdFrames(corrupt, frames), /failed validation/);
});
