import test from 'node:test';
import assert from 'node:assert/strict';
import { joinAllPublicChannels, joinChannel, registerAutoJoin } from '../src/autojoin.mjs';

function fakeClient(pages, joinErrors = {}) {
  const joined = [];
  let i = 0;
  return {
    joined,
    conversations: {
      list: async () => pages[i++],
      join: async ({ channel }) => {
        if (joinErrors[channel]) throw Object.assign(new Error('x'), { data: { error: joinErrors[channel] } });
        joined.push(channel);
        return { ok: true };
      },
    },
  };
}
const logger = { warn() {} };

test('봇이 없는 공개 채널에만 들어가고 페이지를 끝까지 넘긴다', async () => {
  const client = fakeClient([
    { channels: [{ id: 'C1', is_member: true }, { id: 'C2', is_member: false }], response_metadata: { next_cursor: 'n' } },
    { channels: [{ id: 'C3', is_member: false }, { id: 'C4', is_member: false, is_archived: true }], response_metadata: { next_cursor: '' } },
  ]);
  const r = await joinAllPublicChannels(client, logger);
  assert.deepEqual(client.joined, ['C2', 'C3']);
  assert.deepEqual(r, { joined: 2, skipped: 2, failed: 0 });
});

test('이미 들어간 채널 오류는 건너뜀, 그 외 오류는 실패로 센다', async () => {
  const client = fakeClient([
    { channels: [{ id: 'C1' }, { id: 'C2' }] },
  ], { C1: 'already_in_channel', C2: 'missing_scope' });
  const r = await joinAllPublicChannels(client, logger);
  assert.deepEqual(r, { joined: 0, skipped: 1, failed: 1 });
});

test('channel_created / channel_unarchive 이벤트에서 들어간다', async () => {
  const handlers = {};
  registerAutoJoin({ event: (n, fn) => { handlers[n] = fn; } }, { logger });
  const client = fakeClient([]);
  await handlers.channel_created({ event: { channel: { id: 'C9' } }, client });
  await handlers.channel_unarchive({ event: { channel: 'C8' }, client });
  assert.deepEqual(client.joined, ['C9', 'C8']);
});

test('joinChannel 은 예외를 밖으로 던지지 않는다', async () => {
  const client = fakeClient([], { C1: 'ratelimited' });
  assert.equal(await joinChannel(client, 'C1', logger), 'failed');
});
