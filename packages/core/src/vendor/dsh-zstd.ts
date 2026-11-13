// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only
//
// Frame scanning adapted from DeepSeek Harness
// (github.com/deepseek-ai/deepseek-harness, MIT License, Copyright (c) DeepSeek AI):
//   packages/session/session-persistence-jsonl/src/zstd.ts
// via the Obelisk vendored copy (tommy0103/obelisk packages/core/src/vendor/dsh-zstd.ts,
// harness commit 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca). See vendor/README.md.

/**
 * DeepSeek Harness 多帧 Zstandard 会话日志的只读解码。
 *
 * DSH 把一个会话日志写成若干独立、带校验和的 Zstandard frame 的拼接（header 一帧，
 * 之后每个持久化批次一帧）。Node 的一次性 `zstdDecompressSync` 只解到第一个帧边界，
 * 因此先按结构扫描完整帧的字节范围，再逐帧解码。EOF 落在最后一帧内部时返回
 * `tornStart`：DSH 自己会修复撕裂尾部，那部分字节不含已提交事件，读取方直接忽略。
 *
 * 相对上游的调整：只保留读取侧；只用 Node 公开的一次性 API（不依赖私有 stream 句柄）；
 * 按 RFC 8878 只把 frame header 的保留位（0x08）视为损坏，忽略未使用位（0x10），
 * 并跳过 skippable frame。模块仅依赖 Node 内建模块，供 CLI 与 Electron 共用。
 */
import zlib from 'node:zlib';

const ZSTD_MAGIC = 0xFD2FB528;
const SKIPPABLE_MAGIC_MASK = 0xFFFFFFF0;
const SKIPPABLE_MAGIC_BASE = 0x184D2A50;

/** 一个结构完整的 Zstandard frame 占用的字节范围（start 含，end 不含）。 */
export interface ZstdFrameRange {
  start: number;
  end: number;
}

/** 拼接 Zstandard 流的结构扫描结果。 */
export interface ZstdFrameScan {
  /** 按文件顺序排列的完整数据帧（不含 skippable frame）。 */
  frames: ZstdFrameRange[];
  /** EOF 中断最后一帧时，该帧的起始偏移。 */
  tornStart?: number;
}

/**
 * 不解压地定位完整帧。结构非法的完整帧抛错；EOF 落在最后一帧内部时返回其起点。
 * @param maxFrames 只需要前若干帧（例如 header）时提前结束。
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    const magic = buffer.readUInt32LE(offset);
    offset += 4;

    if ((magic & SKIPPABLE_MAGIC_MASK) === SKIPPABLE_MAGIC_BASE) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      const size = buffer.readUInt32LE(offset);
      offset += 4;
      if (buffer.length - offset < size) return { frames, tornStart: start };
      offset += size;
      continue;
    }
    if (magic !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${start}`);
    }

    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x08) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      // RLE block（type 1）在负载中只存一个字节。
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length >= maxFrames) return { frames };
  }

  return { frames };
}

type ZstdDecompress = (input: Buffer) => Buffer;

/** Node 22.15 起提供 `zstdDecompressSync`；更早的运行时返回 null。 */
export function zstdDecoder(): ZstdDecompress | null {
  const decompress = (zlib as unknown as { zstdDecompressSync?: ZstdDecompress }).zstdDecompressSync;
  return typeof decompress === 'function' ? decompress : null;
}

/** 逐帧解码完整帧；任一完整帧校验或解压失败都视为损坏并抛错。 */
export function decodeZstdFrames(buffer: Buffer, frames: readonly ZstdFrameRange[]): Buffer[] {
  const decompress = zstdDecoder();
  if (decompress === null) {
    throw new Error('Reading Zstandard-compressed DeepSeek Harness sessions requires Node.js 22.15 or newer');
  }
  return frames.map(({ start, end }) => {
    try {
      return decompress(buffer.subarray(start, end));
    } catch (error) {
      throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, { cause: error });
    }
  });
}
