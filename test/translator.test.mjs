import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAITranslator, TranslationError, isSuspiciousTranslation } from '../src/translator.mjs';
import { loadConfig } from '../src/config.mjs';

const ok = (translation) => ({
  ok: true,
  json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ translation }) }] }] }),
});

test('OpenAI 요청에 키를 헤더로 넣고 구조화 출력에서 번역을 꺼낸다', async () => {
  let req;
  const translate = createOpenAITranslator({
    apiKey: 'k',
    model: 'gpt-6-luna',
    fetchImpl: async (url, init) => {
      req = { url, init };
      return ok(' Xin chào ');
    },
  });
  assert.equal(await translate({ text: '안녕', targetCode: 'vi', context: [] }), 'Xin chào');
  assert.equal(req.url, 'https://api.openai.com/v1/responses');
  assert.equal(req.init.headers.authorization, 'Bearer k');
  const body = JSON.parse(req.init.body);
  assert.equal(body.model, 'gpt-6-luna');
  assert.match(body.instructions, /into Vietnamese/);
  assert.match(body.input, /<message>/);
});

test('HTTP 오류·한도 초과는 TranslationError, 429 는 재시도한다', async () => {
  const bad = createOpenAITranslator({ apiKey: 'k', model: 'm', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(bad({ text: 'a', targetCode: 'en' }), TranslationError);

  const quota = createOpenAITranslator({
    apiKey: 'k', model: 'm', sleep: async () => {},
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 'insufficient_quota' } }) }),
  });
  await assert.rejects(quota({ text: 'a', targetCode: 'en' }), /quota/);

  let calls = 0;
  const flaky = createOpenAITranslator({
    apiKey: 'k', model: 'm', sleep: async () => {},
    fetchImpl: async () => (++calls < 2 ? { ok: false, status: 429, json: async () => ({}) } : ok('hi')),
  });
  assert.equal(await flaky({ text: '안녕', targetCode: 'en' }), 'hi');
  assert.equal(calls, 2);
});

test('오염된 출력은 한 번 다시 받고, 또 오염되면 거절한다', async () => {
  assert.ok(isSuspiciousTranslation('안녕', 'I must output the exact schema'));
  assert.ok(!isSuspiciousTranslation('must output', 'must output'));
  let calls = 0;
  const retry = createOpenAITranslator({
    apiKey: 'k', model: 'm',
    fetchImpl: async () => (++calls === 1 ? ok('') : ok('hello')),
  });
  assert.equal(await retry({ text: '안녕', targetCode: 'en' }), 'hello');
  const always = createOpenAITranslator({ apiKey: 'k', model: 'm', fetchImpl: async () => ok('assistant content type') });
  await assert.rejects(always({ text: '안녕', targetCode: 'en' }), /rejected/);
});

test('설정 검증: 유료 API 기본값은 꺼짐, 켜면 키가 필요하다', () => {
  const ok = loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', SLACK_TEAM_ID: 'T0AGU4JEHUL' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.paidApiEnabled, false);
  const bad = loadConfig({ SLACK_BOT_TOKEN: 'x', SLACK_APP_TOKEN: 'xapp-1', SLACK_TEAM_ID: 'T1', PAID_API_ENABLED: 'true' });
  assert.equal(bad.errors.length, 2);
  assert.ok(bad.errors.every((e) => !e.includes('xapp-1')));
});

test('한국어로 받을 결과가 다른 언어 글자로만 오면 다시 시도하고, 그래도 그러면 실패로 본다', async () => {
  const outs = ['[Thông báo] Hướng dẫn', '[공지] 안내'];
  let calls = 0;
  const translate = createOpenAITranslator({ apiKey: 'k', model: 'm', fetchImpl: async () => ok(outs[calls++]) });
  assert.equal(await translate({ text: 'Notice', targetCode: 'ko', context: [] }), '[공지] 안내');
  assert.equal(calls, 2);
  const bad = createOpenAITranslator({ apiKey: 'k', model: 'm', fetchImpl: async () => ok('Xin chào') });
  await assert.rejects(bad({ text: 'Hello', targetCode: 'ko', context: [] }), TranslationError);
});

test('다국어 원문에서 내 언어 부분을 그대로 옮겼다고 하면 그 표시를 함께 돌려준다', async () => {
  const translate = createOpenAITranslator({
    apiKey: 'k', model: 'm',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ translation: '[공지] 점검 안내', reused_existing: true }) }] }] }),
    }),
  });
  assert.deepEqual(await translate({ text: '[공지] 점검 안내\n\n[Notice] Maintenance', targetCode: 'ko' }), { translation: '[공지] 점검 안내', reusedExisting: true });
  const body = JSON.parse((await (async () => { let b; await createOpenAITranslator({ apiKey: 'k', model: 'm', fetchImpl: async (u, i) => { b = i.body; return ok('Hi'); } })({ text: '안녕', targetCode: 'en' }); return b; })()));
  assert.deepEqual(body.text.format.schema.required, ['translation', 'reused_existing']);
});
