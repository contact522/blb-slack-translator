import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createUserTokenStore } from '../src/userTokens.mjs';
import { signState, verifyState, createOAuthRoutes, USER_SCOPES } from '../src/oauth.mjs';
import { loadConfig } from '../src/config.mjs';

const keyHex = crypto.randomBytes(32).toString('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));

test('토큰은 암호화되어 저장되고, 파일에는 평문이 없다', () => {
  const dir = tmp();
  const file = path.join(dir, 'user-tokens.json');
  const store = createUserTokenStore({ file, auditFile: path.join(dir, 'audit.log'), keyHex });
  store.set('U1', 'xoxp-secret-value-123', 'im:history');
  assert.equal(store.get('U1'), 'xoxp-secret-value-123');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('xoxp-secret-value-123'), '파일에 평문 토큰이 들어가면 안 됨');
  // 다시 열어도 복호화된다
  const reopened = createUserTokenStore({ file, auditFile: path.join(dir, 'audit.log'), keyHex });
  assert.equal(reopened.get('U1'), 'xoxp-secret-value-123');
});

test('해독 키가 다르면 토큰을 풀 수 없다(다시 연결 필요)', () => {
  const dir = tmp();
  const file = path.join(dir, 'user-tokens.json');
  createUserTokenStore({ file, auditFile: path.join(dir, 'a.log'), keyHex }).set('U1', 'xoxp-abc', 's');
  const other = createUserTokenStore({ file, auditFile: path.join(dir, 'a.log'), keyHex: crypto.randomBytes(32).toString('hex') });
  assert.equal(other.get('U1'), null);
});

test('연결 해제·읽기 기록이 감사 로그에 남고 본문은 없다', () => {
  const dir = tmp();
  const auditFile = path.join(dir, 'audit.log');
  const store = createUserTokenStore({ file: path.join(dir, 't.json'), auditFile, keyHex });
  store.set('U1', 'xoxp-abc', 'im:history');
  store.record('U1', 'dm', 'D123');
  store.delete('U1', 'app_removed');
  const log = fs.readFileSync(auditFile, 'utf8');
  assert.match(log, /connect user=U1/);
  assert.match(log, /read user=U1 type=dm channel=D123/);
  assert.match(log, /disconnect user=U1 reason=app_removed/);
  assert.ok(!store.has('U1'));
});

test('연결 링크 state 는 위조를 막고 만료된다', () => {
  const secret = 'sekret';
  const s = signState(secret, 1000);
  assert.ok(verifyState(secret, s, 1000));
  assert.ok(!verifyState('other', s, 1000)); // 다른 비밀키로는 실패
  assert.ok(!verifyState(secret, s, 1000 + 11 * 60 * 1000)); // 11분 뒤 만료
  assert.ok(!verifyState(secret, 'garbage', 1000));
});

test('OAuth 콜백: 유효한 code 면 토큰을 저장하고, 다른 워크스페이스는 거절한다', async () => {
  const dir = tmp();
  const store = createUserTokenStore({ file: path.join(dir, 't.json'), auditFile: path.join(dir, 'a.log'), keyHex });
  const config = {
    teamId: 'T1', publicUrl: 'https://x.app', clientId: 'cid', clientSecret: 'sec', stateSecret: 'st',
  };
  const fakeFetch = (body) => async () => ({ json: async () => body });

  const okHandle = createOAuthRoutes({
    config, userTokens: store, logger: { info() {}, warn() {} },
    fetchImpl: fakeFetch({ ok: true, team: { id: 'T1' }, authed_user: { id: 'U9', access_token: 'xoxp-live', scope: USER_SCOPES.join(',') } }),
  });
  const res = () => { let s, h, b; return { writeHead: (x, y) => { s = x; h = y; }, end: (x) => { b = x; }, get: () => ({ s, h, b }) }; };

  const good = res();
  const state = signState('st');
  await okHandle({ url: `/slack/oauth_redirect?code=c&state=${state}` }, good);
  assert.equal(store.get('U9'), 'xoxp-live');
  assert.match(good.get().b, /연결됐습니다/);

  // 다른 워크스페이스 토큰은 저장하지 않는다
  const badHandle = createOAuthRoutes({
    config, userTokens: store, logger: { info() {}, warn() {} },
    fetchImpl: fakeFetch({ ok: true, team: { id: 'T_OTHER' }, authed_user: { id: 'UX', access_token: 'xoxp-x', scope: 's' } }),
  });
  const bad = res();
  await badHandle({ url: `/slack/oauth_redirect?code=c&state=${signState('st')}` }, bad);
  assert.equal(store.get('UX'), null);
});

test('설정: DM 값이 모두 있으면 dmEnabled, 일부만 있으면 오류', () => {
  const base = { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', SLACK_TEAM_ID: 'T0AGU4JEHUL' };
  const off = loadConfig(base);
  assert.equal(off.dmEnabled, false);
  assert.deepEqual(off.errors, []);

  const full = loadConfig({
    ...base, PUBLIC_URL: 'https://x.app/', SLACK_CLIENT_ID: 'c', SLACK_CLIENT_SECRET: 's',
    STATE_SECRET: 'st', TOKEN_KEY: keyHex,
  });
  assert.equal(full.dmEnabled, true);
  assert.equal(full.installUrl, 'https://x.app/slack/install');
  assert.deepEqual(full.errors, []);

  const partial = loadConfig({ ...base, PUBLIC_URL: 'https://x.app', SLACK_CLIENT_ID: 'c' });
  assert.equal(partial.dmEnabled, false);
  assert.ok(partial.errors.some((e) => e.includes('DM 번역 설정이 일부만')));
});
