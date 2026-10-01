// 채널 🌐: 봇으로 먼저 읽고, 봇이 못 읽으면(봇 없는 채널·그룹DM) 연결된 본인 토큰으로 처리한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHandlers } from '../src/handlers.mjs';
import { createRateLimiter } from '../src/core.mjs';
import { createMemoryPrefStore } from '../src/prefs.mjs';
import { createMemoryUserTokenStore } from '../src/userTokens.mjs';

const logger = { info() {}, warn() {}, error() {} };

function client({ tag, inChannel = true } = {}) {
  const calls = [];
  return {
    calls, tag,
    views: { open: async (a) => { calls.push(['open', a]); } },
    chat: { postEphemeral: async (a) => { calls.push(['ephemeral', a]); } },
    conversations: {
      history: async (a) => {
        calls.push(['history', a]);
        if (!inChannel) throw Object.assign(new Error('x'), { data: { error: 'not_in_channel' } });
        return { messages: [{ ts: '5.0', text: '내일 배송' }] };
      },
      replies: async () => ({ messages: [] }),
    },
  };
}

function setup({ bot, user }) {
  const handlers = {};
  const app = {
    client: { constructor: class {} },
    shortcut() {}, action() {}, view() {},
    event: (id, fn) => { handlers[id] = fn; },
  };
  const userTokens = createMemoryUserTokenStore();
  if (user) userTokens.set('U1', 'xoxp-u1', 'im:history');
  const prefs = createMemoryPrefStore();
  prefs.set('U1', 'th');
  registerHandlers(app, {
    config: { teamId: 'T1', paidApiEnabled: true, reaction: 'globe_with_meridians' },
    translate: async (a) => `번역-${a.targetCode}`,
    limiter: createRateLimiter({ perUserPerMinute: 5, perDay: 100 }),
    logger, prefs, userTokens,
    makeClient: () => user,
    respond: async () => {},
  });
  const react = (channel = 'C7') => handlers.reaction_added({
    body: { team_id: 'T1' },
    event: { reaction: 'globe_with_meridians', user: 'U1', item: { type: 'message', channel, ts: '5.0' } },
    client: bot,
  });
  return { react, userTokens };
}

test('연결된 사람이라도 봇이 있는 채널은 봇으로 읽고 보낸다 (본인 토큰 읽기 없음)', async () => {
  const bot = client({ tag: 'bot', inChannel: true });
  const user = client({ tag: 'user' });
  const { react, userTokens } = setup({ bot, user });
  await react();
  assert.ok(bot.calls.some((c) => c[0] === 'ephemeral'));
  assert.equal(user.calls.length, 0);
  assert.equal(userTokens.log.some((l) => l.startsWith('read')), false);
});

test('봇이 못 읽는 대화방(그룹DM 등)은 연결된 본인 토큰으로 읽고 본인으로서 보낸다', async () => {
  const bot = client({ tag: 'bot', inChannel: false });
  const user = client({ tag: 'user' });
  const { react, userTokens } = setup({ bot, user });
  await react('C8');
  assert.ok(user.calls.some((c) => c[0] === 'ephemeral'));
  assert.ok(userTokens.log.includes('read U1 channel C8'));
});

test('봇도 못 읽고 연결도 안 했으면 아무것도 보내지 않는다', async () => {
  const bot = client({ tag: 'bot', inChannel: false });
  const { react } = setup({ bot, user: null });
  await react();
  assert.equal(bot.calls.some((c) => c[0] === 'ephemeral'), false);
});
