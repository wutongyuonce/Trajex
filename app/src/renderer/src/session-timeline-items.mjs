// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

function timelineItem(kind, message, messageUuid, extras = {}) {
  return {
    key: `${kind}:${messageUuid}`,
    kind,
    anchorUuid: kind === 'workflow-tools' ? `${messageUuid}-tools` : messageUuid,
    messageUuid,
    message,
    ...extras,
  };
}

function messageItems(message, index) {
  const messageUuid = message?.uuid || `message-${index}`;
  if (message?.is_meta === 1) {
    return [timelineItem('meta', message, messageUuid)];
  }

  const workflowCall = message?.type !== 'user'
    ? (message?.tool_calls || []).find(call => call.name === 'Workflow' && call.workflow)
    : null;
  if (workflowCall) {
    const items = [timelineItem('workflow', message, messageUuid, { workflowCall })];
    const toolCalls = (message.tool_calls || []).filter(call => call !== workflowCall);
    if (toolCalls.length) {
      items.push(timelineItem('workflow-tools', message, messageUuid, { toolCalls }));
    }
    return items;
  }

  if (message?.type === 'assistant' && message.content_type === 'thinking') {
    return [timelineItem('thinking', message, messageUuid)];
  }

  return [timelineItem('message', message, messageUuid)];
}

function summaryItem(summary, index) {
  const id = String(summary?.id || `summary-${index}`);
  return {
    key: `summary:${id}`,
    kind: 'summary',
    anchorUuid: id,
    messageUuid: null,
    summary,
  };
}

function itemTimestamp(item) {
  const value = item.kind === 'summary' ? item.summary?.timestamp : item.message?.timestamp;
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

export function reconcileTimelineItems(current = [], messages = [], summaries = []) {
  const currentByKey = new Map(current.map(item => [item.key, item]));
  const messageItemsInOrder = messages.flatMap((message, index) => (
    messageItems(message, index).map(item => {
      const existing = currentByKey.get(item.key);
      return existing?.message === item.message ? existing : item;
    })
  ));
  const summaryItems = summaries.map((summary, index) => {
    const item = summaryItem(summary, index);
    const existing = currentByKey.get(item.key);
    return existing?.summary === summary ? existing : item;
  }).sort((left, right) => itemTimestamp(left) - itemTimestamp(right));

  // Keep transcript order authoritative. A global sort would reorder messages
  // with equal/missing timestamps lexicographically by key (e.g. message-1000
  // before message-999) and invalidate virtual-row identity on tail appends.
  const items = [];
  let summaryIndex = 0;
  for (const messageItem of messageItemsInOrder) {
    while (
      summaryIndex < summaryItems.length
      && itemTimestamp(summaryItems[summaryIndex]) < itemTimestamp(messageItem)
    ) {
      items.push(summaryItems[summaryIndex++]);
    }
    items.push(messageItem);
  }
  items.push(...summaryItems.slice(summaryIndex));
  return items;
}
