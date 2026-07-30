export function visibleSessionMessages(messages = [], source, showSidechain = false) {
  return source === 'pi' && !showSidechain
    ? messages.filter(message => message.is_sidechain !== 1)
    : messages;
}

export function sidechainMessageCount(messages = [], source) {
  return source === 'pi'
    ? messages.filter(message => message.is_sidechain === 1).length
    : 0;
}
