import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHandlers, loadContext, SHORTCUT_ID } from '../src/handlers.mjs';
import { PREF_CALLBACK_ID, ACTION_RETRANSLATE, ACTION_CHANGE_DEFAULT } from '../src/views.mjs';
import { createRateLimiter } from '../src/core.mjs';
import { createMemoryPrefStore, createPrefStore } from '../src/prefs.mjs';

function fakeApp() {
  const handlers = {};
  return {
    handlers,
    shortcut: (id, fn) => { handlers[`shortcut:${id}`] = fn; },
    action: (id, fn) => { handlers[`action:${id}`] = fn; },
    view: (id, fn) => { handlers[`view:${id}`] = fn; },
    event: (id, fn) => { handlers[`event:${id}`] = fn; },
  };
}

function fakeClient({ replies, history, ephemeralError } = {}) {
  const calls = [];
  return {
    calls,
    views: { open: async (a) => { calls.push(['open', a]); } },
    chat: {
      postEphemeral: async (a) => {
        calls.push(['ephemeral', a]);
        if (ephemeralError) throw Object.assign(new Error('x'), { data: { error: ephemeralError } });
      },
    },
    conversations: {
      replies: async (a) => {
        calls.push(['replies', a]);
        if (replies instanceof Error) throw replies;
        return { messages: replies ?? [] };
      },
      history: async (a) => { calls.push(['history', a]); return { messages: history ?? [] }; },
    },
  };
}

const logger = { info() {}, warn() {}, error() {} };
const baseConfig = { teamId: 'T1', paidApiEnabled: true, reaction: 'globe_with_meridians' };

function setup({ config = {}, translate = async (a) => `번역-${a.targetCode}`, prefs = createMemoryPrefStore() } = {}) {
  const app = fakeApp();
  const responded = [];
  registerHandlers(app, {
    config: { ...baseConfig, ...config },
    translate,
    limiter: createRateLimiter({ perUserPerMinute: 5, perDay: 100 }),
    logger,
    prefs,
    respond: async (url, payload) => { responded.push({ url, payload }); },
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
    view: { ...view, state: { values: { lang: { lang: { selected_option: { value: 'ko' } } } } } },
    client,
  });
  assert.equal(prefs.get('U1'), 'ko');
  assert.equal(responded.at(-1).url, 'https://resp/3');
  assert.match(text(responded.at(-1).payload), /번역-ko/);
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
