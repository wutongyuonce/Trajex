// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// 设置文件读取若把"无法解析"当作 {}，下一次 settings:set 会只带一个键写回，
// 其余设置被静默丢弃。读取时区分"不存在"与"被拒绝"，保存前先把被拒绝的文件挪开。
// 与 savePersistedSettings 的 writeFileSync 一样同步执行：读取、备份与写入之间不让出事件循环，
// 无需额外排队。rename/copyFile 通过参数注入，测试才能让二者分别失败。

import fs from 'node:fs';

type SettingsRecord = Record<string, unknown>;

interface SettingsReadResult {
  ok: boolean;
  settings: SettingsRecord;
  error?: string;
}

interface SettingsFileOps {
  rename: (from: string, to: string) => void;
  copyFile: (from: string, to: string) => void;
}

const defaultOps: SettingsFileOps = {
  rename: (from, to) => fs.renameSync(from, to),
  copyFile: (from, to) => fs.copyFileSync(from, to),
};

/** 不存在视为空设置；存在但无法读取/解析或不是对象时标记为被拒绝。 */
function readSettingsFile(settingsPath: string): SettingsReadResult {
  let text: string;
  try {
    text = fs.readFileSync(settingsPath, 'utf-8');
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return { ok: true, settings: {} };
    return { ok: false, settings: {}, error: `Trajex settings at ${settingsPath} could not be read: ${errorMessage(error)}` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, settings: parsed as SettingsRecord };
    return { ok: false, settings: {}, error: `Trajex settings at ${settingsPath} are not a JSON object` };
  } catch (error) {
    return { ok: false, settings: {}, error: `Trajex settings at ${settingsPath} are not valid JSON: ${errorMessage(error)}` };
  }
}

/**
 * 返回被拒绝文件的保留路径；无需保留（文件不存在或可读）时返回 null。
 * 被拒绝且无法保留时抛错：调用方必须保持原文件不动，而不是覆盖它。
 */
function preserveRejectedSettings(
  settingsPath: string,
  currentRead: SettingsReadResult,
  { rename, copyFile }: SettingsFileOps = defaultOps,
): string | null {
  if (currentRead.ok) return null;
  // 用 Date.now() 而非 ISO 时间：ISO 中的冒号在 Windows 文件名里不合法。
  const backupPath = `${settingsPath}.corrupt-${Date.now()}`;
  try {
    rename(settingsPath, backupPath);
  } catch (renameError) {
    // 另一个句柄仍持有文件时 rename 会被拒绝（Windows 索引器、编辑器、杀毒软件）；
    // 复制同样保留原字节，原文件随后无论如何都会被保存覆盖。
    try {
      copyFile(settingsPath, backupPath);
    } catch (copyError) {
      throw new Error(
        `Trajex could not back up ${settingsPath} before replacing it (${errorMessage(copyError)}), `
        + 'so it was left unchanged and the setting was not saved.',
        { cause: renameError },
      );
    }
  }
  return backupPath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { preserveRejectedSettings, readSettingsFile };
export type { SettingsReadResult };
