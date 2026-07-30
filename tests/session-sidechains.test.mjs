import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sidechainMessageCount,
  visibleSessionMessages,
} from '../app/src/renderer/src/session-sidechains.mjs';

test('Pi sidechain messages are hidden by default and return when expanded', () => {
  const messages = [
    { uuid: 'main', is_sidechain: 0 },
    { uuid: 'branch', is_sidechain: 1 },
  ];
  assert.deepEqual(visibleSessionMessages(messages, 'pi', false), [messages[0]]);
  assert.deepEqual(visibleSessionMessages(messages, 'pi', true), messages);
  assert.deepEqual(visibleSessionMessages(messages, 'pi', false), [messages[0]]);
  assert.equal(sidechainMessageCount(messages, 'pi'), 1);
});
