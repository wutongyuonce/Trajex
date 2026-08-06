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
