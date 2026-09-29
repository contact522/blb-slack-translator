import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiTranslator, TranslationError } from '../src/translator.mjs';
import { loadConfig } from '../src/config.mjs';

test('Gemini 요청에 키를 헤더로 넣고 응답 텍스트를 꺼낸다', async () => {
  let req;
  const translate = createGeminiTranslator({
    apiKey: 'k',
    model: 'm',
    fetchImpl: async (url, init) => {
      req = { url, init };
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: ' Xin chào ' }] } }] }) };
    },
  });
  assert.equal(await translate({ text: '안녕', targetCode: 'vi', context: [] }), 'Xin chào');
  assert.match(req.url, /models\/m:generateContent$/);
  assert.equal(req.init.headers['x-goog-api-key'], 'k');
  assert.doesNotMatch(req.url, /key=/);
});

test('HTTP 오류와 빈 응답은 TranslationError 로 알린다', async () => {
  const bad = createGeminiTranslator({ apiKey: 'k', model: 'm', fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(bad({ text: 'a', targetCode: 'en' }), TranslationError);
  const empty = createGeminiTranslator({
    apiKey: 'k', model: 'm',
    fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'SAFETY' }] }) }),
  });
  await assert.rejects(empty({ text: 'a', targetCode: 'en' }), /SAFETY/);
});

test('설정 검증: 유료 API 기본값은 꺼짐, 켜면 키가 필요하다', () => {
  const ok = loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', SLACK_TEAM_ID: 'T0AGU4JEHUL' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.paidApiEnabled, false);
  const bad = loadConfig({ SLACK_BOT_TOKEN: 'x', SLACK_APP_TOKEN: 'xapp-1', SLACK_TEAM_ID: 'T1', PAID_API_ENABLED: 'true' });
  assert.equal(bad.errors.length, 2);
  assert.ok(bad.errors.every((e) => !e.includes('xapp-1')));
});
