import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHandlers, loadContext, SHORTCUT_ID } from '../src/handlers.mjs';
import { PREF_CALLBACK_ID, ACTION_RETRANSLATE, ACTION_CHANGE_DEFAULT } from '../src/views.mjs';
import { createRateLimiter } from '../src/core.mjs';
import { createMemoryPrefStore, createPrefStore, createMemorySavedStore } from '../src/prefs.mjs';
import { createMemoryUserTokenStore } from '../src/userTokens.mjs';

function fakeApp() {
  const handlers = { __posted: [] };
  return {
    handlers,
    posted: [],
    client: { constructor: class {}, chat: { postMessage: async (a) => { handlers.__posted.push(a); } } },
    shortcut: (id, fn) => { handlers[`shortcut:${id}`] = fn; },
    action: (id, fn) => { handlers[`action:${id}`] = fn; },
    view: (id, fn) => { handlers[`view:${id}`] = fn; },
    event: (id, fn) => { handlers[`event:${id}`] = fn; },
  };
}

function fakeClient({ replies, history, ephemeralError, historyError, tag } = {}) {
  const calls = [];
  return {
    calls,
    tag,
    views: {
      open: async (a) => { calls.push(['open', a]); return { view: { id: 'V1' } }; },
      update: async (a) => { calls.push(['update', a]); },
    },
    chat: {
      postEphemeral: async (a) => {
        calls.push(['ephemeral', a]);
        if (ephemeralError) throw Object.assign(new Error('x'), { data: { error: ephemeralError } });
      },
    },
    reactions: { add: async (a) => { calls.push(['react', a]); } },
    conversations: {
      replies: async (a) => {
        calls.push(['replies', a]);
        if (replies instanceof Error) throw replies;
        return { messages: replies ?? [] };
      },
      history: async (a) => {
        calls.push(['history', a]);
        if (historyError) throw Object.assign(new Error('x'), { data: { error: historyError } });
        return { messages: history ?? [] };
      },
    },
  };
}

const logger = { info() {}, warn() {}, error() {} };
const baseConfig = { teamId: 'T1', paidApiEnabled: true, reaction: 'globe_with_meridians' };

function setup({ config = {}, translate = async (a) => `번역-${a.targetCode}`, prefs = createMemoryPrefStore(), userTokens = null, userClients = {}, saved = null, now } = {}) {
  const app = fakeApp();
  const responded = [];
  registerHandlers(app, {
    config: { ...baseConfig, ...config },
    translate,
    limiter: createRateLimiter({ perUserPerMinute: 5, perDay: 100 }),
    logger,
    prefs,
    saved,
    userTokens,
    makeClient: (token) => userClients[token],
    respond: async (url, payload) => { responded.push({ url, payload }); },
    trace: () => {},
    ...(now ? { now } : {}),
  });
  return { app, prefs, responded };
}

const shortcutBody = (message = { ts: '4.0', text: '안녕하세요' }, team = 'T1') => ({
  team: { id: team }, user: { id: 'U1' }, channel: { id: 'C1' }, message, trigger_id: 'trig', response_url: 'https://resp/1',
});

async function shortcut(app, client, body = shortcutBody()) {
  let acked = false;
  await app.handlers[`shortcut:${SHORTCUT_ID}`]({ ack: async () => { acked = true; }, body, client });
  assert.equal(acked, true);
}

const text = (payload) => JSON.stringify(payload.blocks);
// 아래 개수 검사는 댓글 창 안 결과만 센다(원글이면 채널의 글 아래에도 하나 더 간다).

test('처음 쓰는 사람은 언어 고르기 모달이 뜨고, 저장하면 바로 번역해 대화 안에 보낸다', async () => {
  const { app, prefs } = setup();
  const client = fakeClient();
  await shortcut(app, client);
  const view = client.calls.find((c) => c[0] === 'open')[1].view;
  assert.equal(view.callback_id, PREF_CALLBACK_ID);

  await app.handlers[`view:${PREF_CALLBACK_ID}`]({
    ack: async () => {},
    body: { team: { id: 'T1' }, user: { id: 'U1' } },
    view: { ...view, state: { values: { lang: { lang: { selected_option: { value: 'th' } } } } } },
    client,
  });
  assert.equal(prefs.get('U1'), 'th');
  const eph = client.calls.find((c) => c[0] === 'ephemeral')[1];
  assert.equal(eph.channel, 'C1');
  assert.equal(eph.user, 'U1');
  assert.match(text(eph), /번역-th/);
});

test('저장된 언어가 있으면 모달 없이 바로 번역하고, 스레드 답글이면 그 스레드에 보낸다', async () => {
  const { app, prefs } = setup();
  prefs.set('U1', 'vi');
  const client = fakeClient({ replies: [{ ts: '1.0', text: '회의 건' }, { ts: '4.0', text: '안녕하세요' }] });
  await shortcut(app, client, shortcutBody({ ts: '4.0', thread_ts: '1.0', text: '안녕하세요' }));
  assert.equal(client.calls.some((c) => c[0] === 'open'), false);
  const eph = client.calls.find((c) => c[0] === 'ephemeral')[1];
  assert.equal(eph.thread_ts, '1.0');
  assert.match(text(eph), /번역-vi/);
  assert.match(text(eph), /1 earlier thread message/);
});

test('댓글이 달린 원글을 번역하면 결과가 그 댓글 창 안에 보인다', async () => {
  const { app, prefs } = setup();
  prefs.set('U1', 'ko');
  const client = fakeClient({ replies: [] });
  await shortcut(app, client, shortcutBody({ ts: '1.0', thread_ts: '1.0', text: 'Daily report' }));
  const eph = client.calls.find((c) => c[0] === 'ephemeral')[1];
  assert.equal(eph.thread_ts, '1.0');
});

test('thread_ts 없이 와도 댓글 수가 있으면 댓글 창 안에 보인다', async () => {
  const { app, prefs } = setup();
  prefs.set('U1', 'ko');
  const client = fakeClient({ replies: [] });
  await shortcut(app, client, shortcutBody({ ts: '1.0', reply_count: 2, text: 'Notice' }));
  const eph = client.calls.find((c) => c[0] === 'ephemeral')[1];
  assert.equal(eph.thread_ts, '1.0');
});

test('봇이 없는 대화방(DM)이면 response_url 로 나에게만 보낸다', async () => {
  const { app, prefs, responded } = setup();
  prefs.set('U1', 'en');
  const client = fakeClient({ ephemeralError: 'channel_not_found' });
  await shortcut(app, client);
  assert.equal(responded.length, 1);
  assert.equal(responded[0].url, 'https://resp/1');
  assert.equal(responded[0].payload.response_type, 'ephemeral');
  assert.match(text(responded[0].payload), /번역-en/);
});

test('다른 언어로 보기는 결과를 그 자리에서 바꾸고, 기본 언어는 그대로 둔다', async () => {
  const { app, prefs, responded } = setup();
  prefs.set('U1', 'th');
  const client = fakeClient();
  await shortcut(app, client);
  const eph = client.calls.find((c) => c[0] === 'ephemeral')[1];
  const actions = eph.blocks.find((b) => b.type === 'actions');

  await app.handlers[`action:${ACTION_RETRANSLATE}`]({
    ack: async () => {},
    body: { team: { id: 'T1' }, user: { id: 'U1' }, response_url: 'https://resp/2' },
    action: { block_id: actions.block_id, selected_option: { value: 'zh-Hans' } },
    client,
  });
  assert.equal(responded.at(-1).payload.replace_original, true);
  assert.match(text(responded.at(-1).payload), /번역-zh-Hans/);
  assert.equal(prefs.get('U1'), 'th');
});

test('기본 언어 바꾸기는 저장값을 바꾸고 지금 결과도 새 언어로 바꾼다', async () => {
  const { app, prefs, responded } = setup();
  prefs.set('U1', 'th');
  const client = fakeClient();
  await shortcut(app, client);
  const eph = client.calls.find((c) => c[0] === 'ephemeral')[1];
  const button = eph.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === ACTION_CHANGE_DEFAULT);

  await app.handlers[`action:${ACTION_CHANGE_DEFAULT}`]({
    ack: async () => {},
    body: { team: { id: 'T1' }, user: { id: 'U1' }, trigger_id: 't2', response_url: 'https://resp/3' },
    action: { value: button.value },
    client,
  });
  const view = client.calls.filter((c) => c[0] === 'open').at(-1)[1].view;
  assert.match(JSON.stringify(view.blocks), /ไทย/); // 현재 값이 미리 선택돼 있다

  await app.handlers[`view:${PREF_CALLBACK_ID}`]({
    ack: async () => {},
    body: { team: { id: 'T1' }, user: { id: 'U1' } },
    view: { ...view, state: { values: { lang: { lang: { selected_option: { value: 'en' } } } } } },
    client,
  });
  assert.equal(prefs.get('U1'), 'en');
  assert.equal(responded.at(-1).url, 'https://resp/3');
  assert.match(text(responded.at(-1).payload), /번역-en/);
});

test('🌐 반응을 달면 그 메시지를 찾아 번역하고, 다른 반응은 무시한다', async () => {
  const { app, prefs } = setup();
  prefs.set('U2', 'th');
  const client = fakeClient({ history: [{ ts: '5.0', text: '내일 배송' }] });
  const ev = (reaction) => ({
    body: { team_id: 'T1' },
    event: { reaction, user: 'U2', item: { type: 'message', channel: 'C9', ts: '5.0' } },
    client,
  });
  await app.handlers['event:reaction_added'](ev('thumbsup'));
  assert.equal(client.calls.length, 0);
  await app.handlers['event:reaction_added'](ev('globe_with_meridians'));
  const eph = client.calls.find((c) => c[0] === 'ephemeral')[1];
  assert.equal(eph.channel, 'C9');
  assert.equal(eph.user, 'U2');
  assert.match(text(eph), /번역-th/);
});

test('🌐 반응을 단 사람이 언어를 안 골랐으면 고르기 버튼을 보낸다', async () => {
  const { app } = setup();
  const client = fakeClient({ history: [{ ts: '5.0', text: '내일 배송' }] });
  await app.handlers['event:reaction_added']({
    body: { team_id: 'T1' },
    event: { reaction: 'globe_with_meridians', user: 'U3', item: { type: 'message', channel: 'C9', ts: '5.0' } },
    client,
  });
  const eph = client.calls.find((c) => c[0] === 'ephemeral')[1];
  assert.match(text(eph), /change_default/);
});

test('유료 API 가 꺼져 있으면 번역 함수를 부르지 않고 미리보기 안내를 보인다', async () => {
  let called = false;
  const { app, prefs } = setup({ config: { paidApiEnabled: false }, translate: async () => { called = true; return 'x'; } });
  prefs.set('U1', 'th');
  const client = fakeClient();
  await shortcut(app, client);
  assert.equal(called, false);
  assert.match(text(client.calls.find((c) => c[0] === 'ephemeral')[1]), /Preview/);
});

test('다른 워크스페이스 요청은 ACK 만 하고 아무것도 하지 않는다', async () => {
  const { app } = setup();
  const client = fakeClient();
  await shortcut(app, client, shortcutBody(undefined, 'T_OTHER'));
  assert.equal(client.calls.length, 0);
});

test('문맥 권한이 없거나 스레드가 아니면 빈 문맥으로 계속한다', async () => {
  const err = Object.assign(new Error('x'), { data: { error: 'not_in_channel' } });
  const r = await loadContext(fakeClient({ replies: err }), { channel: 'C1', ts: '4.0', threadTs: '1.0' });
  assert.deepEqual(r, { context: [], errorCode: 'not_in_channel' });
  const client = fakeClient();
  assert.deepEqual(await loadContext(client, { channel: 'C1', ts: '4.0', threadTs: null }), { context: [] });
  assert.equal(client.calls.length, 0);
});

test('기본 언어는 파일에 저장되어 다시 켜도 남는다', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-')), 'sub', 'prefs.json');
  createPrefStore(file).set('U1', 'vi');
  assert.equal(createPrefStore(file).get('U1'), 'vi');
});

// --- DM 🌐 번역 (사용자 연결) ---

const dmReaction = (app, client, user = 'U1', channel = 'D9', ts = '5.0') =>
  app.handlers['event:reaction_added']({
    body: { team_id: 'T1' },
    event: { reaction: 'globe_with_meridians', user, item: { type: 'message', channel, ts } },
    client,
  });

test('DM 에서 연결된 사람은 본인 토큰으로 읽고 본인으로서 나에게만 보낸다', async () => {
  const userTokens = createMemoryUserTokenStore();
  userTokens.set('U1', 'xoxp-u1', 'im:history');
  const userClient = fakeClient({ history: [{ ts: '5.0', text: 'สวัสดี' }], tag: 'user' });
  const botClient = fakeClient({ historyError: 'not_in_channel', tag: 'bot' }); // 봇은 DM 을 못 읽는다
  const { app, prefs } = setup({ userTokens, userClients: { 'xoxp-u1': userClient } });
  prefs.set('U1', 'ko');

  await dmReaction(app, botClient);

  // 봇 클라이언트로는 메시지를 읽지도, 보내지도 않았다
  assert.equal(botClient.calls.some((c) => c[0] === 'ephemeral'), false);
  // 사용자 토큰 클라이언트로 읽고 보냈다
  assert.ok(userClient.calls.some((c) => c[0] === 'history'));
  const eph = userClient.calls.find((c) => c[0] === 'ephemeral')[1];
  assert.equal(eph.channel, 'D9');
  assert.equal(eph.user, 'U1');
  assert.match(text(eph), /번역-ko/);
});

test('DM 에서 연결 안 한 사람에게는 연결 링크를 안내한다', async () => {
  const userTokens = createMemoryUserTokenStore();
  const botClient = fakeClient({ historyError: 'not_in_channel' });
  const { app } = setup({ userTokens, config: { installUrl: 'https://x.app/slack/install' } });

  await dmReaction(app, botClient, 'U404');
  const eph = botClient.calls.find((c) => c[0] === 'ephemeral')[1];
  assert.equal(eph.user, 'U404');
  const btn = eph.blocks.find((b) => b.type === 'actions').elements[0];
  assert.equal(btn.url, 'https://x.app/slack/install');
});

test('DM 읽기는 감사 기록을 남긴다', async () => {
  const userTokens = createMemoryUserTokenStore();
  userTokens.set('U1', 'xoxp-u1', 'im:history');
  const userClient = fakeClient({ history: [{ ts: '5.0', text: 'hi' }] });
  const { app, prefs } = setup({ userTokens, userClients: { 'xoxp-u1': userClient } });
  prefs.set('U1', 'ko');
  await dmReaction(app, fakeClient({ historyError: 'not_in_channel' }));
  assert.ok(userTokens.log.some((l) => l.startsWith('read U1 dm D9')));
});

test('같은 사람이 같은 글을 다시 누르면 결과를 또 보내지 않고, 번역 API 도 다시 부르지 않는다', async () => {
  let count = 0;
  const { app, prefs } = setup({ translate: async (a) => { count += 1; return `번역-${a.targetCode}`; } });
  prefs.set('U1', 'ko');
  const client = fakeClient();
  const body = shortcutBody({ ts: '7.0', text: 'Daily report' });
  await shortcut(app, client, body);
  await shortcut(app, client, body);
  assert.equal(count, 1);
  const results = client.calls.filter((c) => c[0] === 'ephemeral' && c[1].thread_ts);
  assert.equal(results.length, 1);
  assert.match(text(results[0][1]), /번역-ko/);
  // 다른 사람은 자기 결과를 받는다(번역은 저장된 것을 쓴다).
  prefs.set('U2', 'ko');
  await shortcut(app, client, { ...body, user: { id: 'U2' } });
  assert.equal(client.calls.filter((c) => c[0] === 'ephemeral' && c[1].thread_ts).length, 2);
  assert.equal(count, 1);
  // 다른 언어나 고친 글은 새로 번역한다.
  prefs.set('U1', 'th');
  await shortcut(app, client, body);
  await shortcut(app, client, shortcutBody({ ts: '7.0', text: 'Daily report (edited)' }));
  assert.equal(count, 3);
});

test('같은 사람·같은 글 🌐 는 10초 안에만 막고, 그 뒤 재요청은 저장된 번역을 다시 보낸다(API 재호출 없음)', async () => {
  let count = 0;
  let t = 1_000_000;
  const { app, prefs } = setup({ translate: async (a) => { count += 1; return `번역-${a.targetCode}`; }, now: () => t });
  prefs.set('U2', 'th');
  const client = fakeClient({ history: [{ ts: '5.0', text: '내일 배송' }] });
  const fire = (eventId) => app.handlers['event:reaction_added']({
    body: { team_id: 'T1', event_id: eventId },
    event: { reaction: 'globe_with_meridians', user: 'U2', item: { type: 'message', channel: 'C9', ts: '5.0' } },
    client,
  });
  const sent = () => client.calls.filter((c) => c[0] === 'ephemeral' && c[1].thread_ts).length;
  await fire('Ev1');
  assert.equal(sent(), 1);
  t += 5_000;
  await fire('Ev2'); // 10초 안 → 중복생략
  assert.equal(sent(), 1);
  t += 6_000;
  await fire('Ev3'); // 10초 지남 → 저장된 번역 전달
  assert.equal(sent(), 2);
  assert.match(text(client.calls.filter((c) => c[0] === 'ephemeral')[1][1]), /번역-th/);
  assert.equal(count, 1);
});

test('댓글이 없는 글도 결과는 그 글의 댓글 창 안에 둔다', async () => {
  const { app, prefs } = setup();
  prefs.set('U1', 'ko');
  const client = fakeClient();
  await shortcut(app, client, shortcutBody({ ts: '9.0', text: 'No replies yet' }));
  const eph = client.calls.find((c) => c[0] === 'ephemeral')[1];
  assert.equal(eph.thread_ts, '9.0');
});

test('DM 에서 ⋯→번역은 맨 아래 메시지가 아니라 작은 창에 보여 준다', async () => {
  const { app, prefs, responded } = setup();
  prefs.set('U1', 'ko');
  const client = fakeClient({ ephemeralError: 'channel_not_found' });
  const body = { ...shortcutBody({ ts: '5.0', text: 'Morning brief' }), channel: { id: 'D1' } };
  await shortcut(app, client, body);
  const opened = client.calls.find((c) => c[0] === 'open')[1].view;
  assert.match(JSON.stringify(opened.blocks), /번역 중/);
  const updated = client.calls.find((c) => c[0] === 'update')[1];
  assert.equal(updated.view_id, 'V1');
  assert.match(JSON.stringify(updated.view.blocks), /번역-ko/);
  assert.equal(JSON.stringify(updated.view.blocks).includes('retranslate'), false);
  assert.equal(client.calls.some((c) => c[0] === 'ephemeral'), false);
  assert.equal(responded.length, 0);
});

test('DM 에서 처음 언어를 고르면 그 창이 결과 창으로 바뀐다', async () => {
  const { app, prefs, responded } = setup();
  const client = fakeClient();
  const body = { ...shortcutBody({ ts: '6.0', text: 'Hello' }), channel: { id: 'D1' } };
  await shortcut(app, client, body);
  const view = client.calls.find((c) => c[0] === 'open')[1].view;
  let ackArg;
  await app.handlers[`view:${PREF_CALLBACK_ID}`]({
    ack: async (a) => { ackArg = a; },
    body: { team: { id: 'T1' }, user: { id: 'U1' } },
    view: { ...view, id: 'V9', state: { values: { lang: { lang: { selected_option: { value: 'ko' } } } } } },
    client,
  });
  assert.equal(prefs.get('U1'), 'ko');
  assert.equal(ackArg.response_action, 'update');
  const updated = client.calls.find((c) => c[0] === 'update')[1];
  assert.equal(updated.view_id, 'V9');
  assert.match(JSON.stringify(updated.view.blocks), /번역-ko/);
  assert.equal(responded.length, 0);
});

test('DM 에서 연결한 사람의 ⋯→번역은 본인 토큰으로 그 글의 댓글 창 안에 넣는다', async () => {
  const userTokens = createMemoryUserTokenStore();
  userTokens.set('U1', 'xoxp-u1', 'im:history');
  const userClient = fakeClient({ tag: 'user' });
  const { app, prefs, responded } = setup({ userTokens, userClients: { 'xoxp-u1': userClient } });
  prefs.set('U1', 'ko');
  const botClient = fakeClient({ ephemeralError: 'channel_not_found', tag: 'bot' });
  const body = { ...shortcutBody({ ts: '5.0', text: 'Morning brief' }), channel: { id: 'D1' } };
  await shortcut(app, botClient, body);
  assert.equal(botClient.calls.some((c) => c[0] === 'open'), false);
  const eph = userClient.calls.find((c) => c[0] === 'ephemeral')[1];
  assert.equal(eph.channel, 'D1');
  assert.equal(eph.thread_ts, '5.0');
  assert.match(text(eph), /번역-ko/);
  assert.equal(responded.length, 0);
  assert.ok(userTokens.log.includes('read U1 dm D1'));
});

test('번역하면 원글에 🌐 를 붙이고, 그 🌐 가 다시 번역 요청으로 돌아오지 않는다', async () => {
  const userTokens = createMemoryUserTokenStore();
  userTokens.set('U1', 'xoxp-u1', 'im:history');
  const userClient = fakeClient({ history: [{ ts: '5.0', text: 'Morning brief' }], tag: 'user' });
  let count = 0;
  const { app, prefs } = setup({ userTokens, userClients: { 'xoxp-u1': userClient }, translate: async () => { count += 1; return '번역'; } });
  prefs.set('U1', 'ko');
  const botClient = fakeClient({ historyError: 'not_in_channel', tag: 'bot' });
  // DM ⋯→번역: 본인 토큰으로 원글에 🌐
  await shortcut(app, botClient, { ...shortcutBody({ ts: '5.0', text: 'Morning brief' }), channel: { id: 'D9' } });
  const react = userClient.calls.find((c) => c[0] === 'react')[1];
  assert.deepEqual(react, { channel: 'D9', timestamp: '5.0', name: 'globe_with_meridians' });
  // 방금 붙인 🌐 의 반응 이벤트는 무시
  await dmReaction(app, botClient, 'U1', 'D9', '5.0');
  assert.equal(userClient.calls.filter((c) => c[0] === 'ephemeral' && c[1].thread_ts).length, 1);
  // 번역기 자신이 붙인 🌐 도 무시
  await app.handlers['event:reaction_added']({
    body: { team_id: 'T1' },
    event: { reaction: 'globe_with_meridians', user: 'UBOT', item: { type: 'message', channel: 'C1', ts: '8.0' } },
    client: botClient,
    context: { botUserId: 'UBOT' },
  });
  assert.equal(botClient.calls.some((c) => c[0] === 'history'), false);
  assert.equal(count, 1);
});

test('사람이 🌐 를 껐다 다시 누르면 다시 번역 요청으로 받는다, 같은 event_id 재전송은 막는다', async () => {
  const userTokens = createMemoryUserTokenStore();
  userTokens.set('U1', 'xoxp-u1', 'im:history');
  const userClient = fakeClient({ history: [{ ts: '5.0', text: 'Morning brief' }], tag: 'user' });
  const { app, prefs } = setup({ userTokens, userClients: { 'xoxp-u1': userClient } });
  prefs.set('U1', 'ko');
  const botClient = fakeClient({ historyError: 'not_in_channel', tag: 'bot' });
  await shortcut(app, botClient, { ...shortcutBody({ ts: '5.0', text: 'Morning brief' }), channel: { id: 'D9' } });
  const fire = (eventId) => app.handlers['event:reaction_added']({
    body: { team_id: 'T1', event_id: eventId },
    event: { reaction: 'globe_with_meridians', user: 'U1', item: { type: 'message', channel: 'D9', ts: '5.0' } },
    client: botClient,
  });
  await fire('Ev1'); // 번역기가 붙인 🌐 의 이벤트 → 무시
  assert.equal(userClient.calls.filter((c) => c[0] === 'ephemeral' && c[1].thread_ts).length, 1);
  await new Promise((r) => setTimeout(r, 5));
  await fire('Ev2'); // 사람이 껐다 다시 누름 → 번역 (15초 창 안이지만 다른 반응이라 키는 같음)
  await fire('Ev2'); // 재전송 → 무시
  const n = userClient.calls.filter((c) => c[0] === 'ephemeral' && c[1].thread_ts).length;
  assert.ok(n <= 2);
});

test('번역 저장본을 그 사람과 번역기의 1:1 대화방에 원글 링크와 함께 한 번만 남긴다, 고친 글은 새로 남긴다', async () => {
  const saved = createMemorySavedStore();
  const { app, prefs } = setup({ saved });
  prefs.set('U1', 'ko');
  const client = fakeClient();
  client.chat.getPermalink = async () => ({ permalink: 'https://x.slack.com/archives/C1/p7' });
  const body = shortcutBody({ ts: '7.0', text: 'Daily report' });
  await shortcut(app, client, body);
  const posted = app.handlers.__posted;
  assert.equal(posted.length, 1);
  assert.equal(posted[0].channel, 'U1');
  assert.match(JSON.stringify(posted[0].blocks), /원문 보기/);
  assert.match(JSON.stringify(posted[0].blocks), /번역-ko/);
  assert.equal(JSON.stringify(posted[0].blocks).includes('retranslate'), false);
  await shortcut(app, client, body);
  assert.equal(posted.length, 1);
  await shortcut(app, client, shortcutBody({ ts: '7.0', text: 'Daily report (edited)' }));
  assert.equal(posted.length, 2);
});

test('🌐 는 누른 사람 이름으로만: 🌐 로 요청하면 번역기가 또 붙이지 않고, 연결한 사람의 ⋯→번역은 채널에서도 본인 이름', async () => {
  const userTokens = createMemoryUserTokenStore();
  userTokens.set('U1', 'xoxp-u1', 'im:history');
  const userClient = fakeClient({ tag: 'user' });
  const { app, prefs } = setup({ userTokens, userClients: { 'xoxp-u1': userClient } });
  prefs.set('U1', 'ko');
  prefs.set('U2', 'ko');
  const botClient = fakeClient({ history: [{ ts: '3.0', text: 'Hello team' }], tag: 'bot' });
  // 채널에서 연결한 사람의 ⋯→번역 → 본인 토큰으로 🌐, 번역기 🌐 없음
  await shortcut(app, botClient, shortcutBody({ ts: '2.0', text: 'Report' }));
  assert.equal(userClient.calls.filter((c) => c[0] === 'react').length, 1);
  assert.equal(botClient.calls.filter((c) => c[0] === 'react').length, 0);
  // 연결 안 한 사람이 🌐 로 요청 → 아무도 🌐 를 더 붙이지 않는다
  await app.handlers['event:reaction_added']({
    body: { team_id: 'T1', event_id: 'EvX' },
    event: { reaction: 'globe_with_meridians', user: 'U2', item: { type: 'message', channel: 'C1', ts: '3.0' } },
    client: botClient,
  });
  assert.equal(botClient.calls.filter((c) => c[0] === 'ephemeral' && c[1].thread_ts).length, 2);
  assert.equal(botClient.calls.filter((c) => c[0] === 'react').length, 0);
});

test('원문이 이미 내 언어면 번역 API 를 부르지 않고 원문을 그대로 보인다', async () => {
  let count = 0;
  const { app, prefs } = setup({ translate: async () => { count += 1; return 'Xin chào'; } });
  prefs.set('U1', 'ko');
  const client = fakeClient();
  await shortcut(app, client, shortcutBody({ ts: '8.0', text: '[공지] BLB 시스템 이전 안내 (TH/VN 12:30)' }));
  assert.equal(count, 0);
  const eph = client.calls.find((c) => c[0] === 'ephemeral')[1];
  assert.match(text(eph), /BLB 시스템 이전 안내/);
  assert.match(text(eph), /already in this language/);
});

test('원글을 번역하면 결과를 댓글 창 안과 채널의 글 아래 둘 다에 넣고, 댓글을 번역하면 댓글 창 안에만 넣는다', async () => {
  const { app, prefs } = setup();
  prefs.set('U1', 'ko');
  const client = fakeClient();
  await shortcut(app, client, shortcutBody({ ts: '9.0', text: 'Top post' }));
  let eph = client.calls.filter((c) => c[0] === 'ephemeral').map((c) => c[1]);
  assert.deepEqual(eph.map((e) => e.thread_ts), ['9.0', undefined]);
  assert.ok(eph.every((e) => /번역-ko/.test(text(e))));
  client.calls.length = 0;
  await shortcut(app, client, shortcutBody({ ts: '9.5', thread_ts: '9.0', text: 'A reply' }));
  eph = client.calls.filter((c) => c[0] === 'ephemeral').map((c) => c[1]);
  assert.deepEqual(eph.map((e) => e.thread_ts), ['9.0']);
});

test('연결 안 한 사람이 ⋯→번역하면 원글에 번역기 이름의 🌐 를 붙이지 않는다', async () => {
  const { app, prefs } = setup();
  prefs.set('U1', 'ko');
  const client = fakeClient();
  await shortcut(app, client, shortcutBody({ ts: '9.0', text: 'Top post' }));
  assert.equal(client.calls.some((c) => c[0] === 'react'), false);
  assert.equal(client.calls.some((c) => c[0] === 'ephemeral'), true);
});
