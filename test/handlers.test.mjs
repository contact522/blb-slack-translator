import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHandlers, loadContext, SHORTCUT_ID } from '../src/handlers.mjs';
import { ACTION_LANGUAGE, BLOCK_CONTROLS } from '../src/views.mjs';
import { createRateLimiter } from '../src/core.mjs';

function fakeApp() {
  const handlers = {};
  return {
    handlers,
    shortcut: (id, fn) => { handlers[`shortcut:${id}`] = fn; },
    action: (id, fn) => { handlers[`action:${id}`] = fn; },
  };
}

function fakeClient({ replies } = {}) {
  const calls = [];
  return {
    calls,
    views: {
      open: async (a) => { calls.push(['open', a]); },
      update: async (a) => { calls.push(['update', a]); },
    },
    conversations: {
      replies: async (a) => {
        calls.push(['replies', a]);
        if (replies instanceof Error) throw replies;
        return { messages: replies ?? [] };
      },
    },
  };
}

const logger = { info() {}, warn() {}, error() {} };
const baseConfig = { teamId: 'T1', paidApiEnabled: false };

function setup(config = {}, translate = async () => 'สวัสดี') {
  const app = fakeApp();
  registerHandlers(app, {
    config: { ...baseConfig, ...config },
    translate,
    limiter: createRateLimiter({ perUserPerMinute: 5, perDay: 100 }),
    logger,
  });
  return app;
}

async function openModal(app, client, message = { ts: '4.0', thread_ts: '1.0', text: '안녕하세요' }, team = 'T1') {
  let acked = false;
  await app.handlers[`shortcut:${SHORTCUT_ID}`]({
    ack: async () => { acked = true; },
    body: { team: { id: team }, channel: { id: 'C1' }, message, trigger_id: 'trig' },
    client,
  });
  assert.equal(acked, true);
  return client.calls.find((c) => c[0] === 'open')?.[1].view;
}

function selectBody(view, language, useContext = false) {
  return {
    team: { id: 'T1' },
    user: { id: 'U1' },
    view: {
      ...view,
      id: 'V1',
      state: {
        values: {
          [BLOCK_CONTROLS]: {
            select_language: { selected_option: { value: language } },
            toggle_context: { selected_options: useContext ? [{ value: 'use_context' }] : [] },
          },
        },
      },
    },
  };
}

test('메시지 메뉴를 누르면 원문이 담긴 개인 모달을 연다', async () => {
  const client = fakeClient();
  const view = await openModal(setup(), client);
  assert.equal(view.type, 'modal');
  assert.match(JSON.stringify(view.blocks), /안녕하세요/);
});

test('다른 워크스페이스 요청은 ACK 만 하고 모달을 열지 않는다', async () => {
  const client = fakeClient();
  const view = await openModal(setup(), client, undefined, 'T_OTHER');
  assert.equal(view, undefined);
});

test('유료 API 가 꺼져 있으면 번역 함수를 부르지 않고 미리보기 안내를 보인다', async () => {
  let called = false;
  const app = setup({}, async () => { called = true; return 'x'; });
  const client = fakeClient();
  const view = await openModal(app, client);
  await app.handlers[`action:${ACTION_LANGUAGE}`]({ ack: async () => {}, body: selectBody(view, 'th'), client });
  const updates = client.calls.filter((c) => c[0] === 'update');
  assert.equal(called, false);
  assert.equal(updates.length, 2);
  assert.match(JSON.stringify(updates[1][1].view.blocks), /Preview/);
});

test('유료 API 가 켜져 있으면 번역 결과와 문맥 사용 여부를 보인다', async () => {
  let got;
  const app = setup({ paidApiEnabled: true }, async (args) => { got = args; return 'สวัสดีครับ'; });
  const client = fakeClient({ replies: [{ ts: '1.0', text: '회의 건' }, { ts: '4.0', text: '안녕하세요' }] });
  const view = await openModal(app, client);
  await app.handlers[`action:${ACTION_LANGUAGE}`]({ ack: async () => {}, body: selectBody(view, 'th', true), client });
  assert.deepEqual(got, { text: '안녕하세요', targetCode: 'th', context: ['회의 건'] });
  const last = JSON.stringify(client.calls.at(-1)[1].view.blocks);
  assert.match(last, /สวัสดีครับ/);
  assert.match(last, /1 earlier thread message/);
});

test('문맥 권한이 없으면 단문 번역임을 알린다', async () => {
  const err = Object.assign(new Error('x'), { data: { error: 'missing_scope' } });
  const r = await loadContext(fakeClient({ replies: err }), { channel: 'C1', ts: '4.0', threadTs: '1.0' });
  assert.deepEqual(r.context, []);
  assert.match(r.note, /No permission/);
  assert.equal(r.errorCode, 'missing_scope');
});

test('스레드가 아니면 문맥을 읽지 않는다', async () => {
  const client = fakeClient();
  const r = await loadContext(client, { channel: 'C1', ts: '4.0', threadTs: null });
  assert.equal(client.calls.length, 0);
  assert.match(r.note, /No earlier/);
});

test('늦게 끝난 옛 번역이 새 결과를 덮어쓰지 않는다', async () => {
  const resolvers = [];
  const app = setup({ paidApiEnabled: true }, (a) => new Promise((r) => resolvers.push(() => r(`결과-${a.targetCode}`))));
  const client = fakeClient();
  const view = await openModal(app, client);
  const h = app.handlers[`action:${ACTION_LANGUAGE}`];
  const first = h({ ack: async () => {}, body: selectBody(view, 'th'), client });
  const second = h({ ack: async () => {}, body: selectBody(view, 'vi'), client });
  await new Promise((r) => setImmediate(r));
  resolvers[1]();
  await second;
  resolvers[0]();
  await first;
  assert.match(JSON.stringify(client.calls.at(-1)[1].view.blocks), /결과-vi/);
});
