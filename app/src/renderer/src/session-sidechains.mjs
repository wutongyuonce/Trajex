// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

export function visibleSessionMessages(messages = [], showInactive = false) {
  return messages.filter(message => (
    message.visibility === 'hidden'
      ? false
      : showInactive || message.visibility !== 'inactive'
  ));
}

export function inactiveMessageCount(messages = []) {
  return messages.filter(message => message.visibility === 'inactive').length;
}
