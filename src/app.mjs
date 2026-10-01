// 진입점. Socket Mode 로 Slack 에 연결하고 127.0.0.1 에 /health 를 연다.
import http from 'node:http';
import bolt from '@slack/bolt';
import { loadConfig } from './config.mjs';
import { createRateLimiter } from './core.mjs';
import { createOpenAITranslator } from './translator.mjs';
import { registerHandlers } from './handlers.mjs';
import { createPrefStore } from './prefs.mjs';
import { createUserTokenStore } from './userTokens.mjs';
import { createOAuthRoutes } from './oauth.mjs';
import { registerAutoJoin, joinAllPublicChannels } from './autojoin.mjs';
import path from 'node:path';

const { App, LogLevel, webApi } = bolt;
const config = loadConfig();
if (config.errors.length) {
  for (const e of config.errors) console.error(`[config] ${e}`);
  console.error('.env 를 확인하세요. (.env.example 참고)');
  process.exit(1);
}

const app = new App({
  token: config.botToken,
  appToken: config.appToken,
  socketMode: true,
  logLevel: LogLevel.WARN,
});
const logger = app.logger;

const state = { socketConnected: false, startedAt: Date.now() };
const socket = app.receiver.client;
socket.on('connected', () => {
  state.socketConnected = true;
  console.log('SLACK_SOCKET_CONNECTED');
});
socket.on('disconnected', () => {
  state.socketConnected = false;
  console.log('SLACK_SOCKET_DISCONNECTED');
});

const prefs = createPrefStore(path.join(config.dataDir, 'prefs.json'));

// DM 🌐 번역이 켜져 있으면 사용자 토큰 저장소와 연결(OAuth) 경로를 준비한다.
let userTokens = null;
let oauthHandle = null;
if (config.dmEnabled) {
  userTokens = createUserTokenStore({
    file: path.join(config.dataDir, 'user-tokens.json'),
    auditFile: path.join(config.dataDir, 'audit.log'),
    keyHex: config.tokenKey,
  });
  oauthHandle = createOAuthRoutes({ config, userTokens, logger });
}

registerHandlers(app, {
  config,
  logger,
  prefs,
  userTokens,
  makeClient: (token) => new webApi.WebClient(token),
  limiter: createRateLimiter({ perUserPerMinute: config.perUserPerMinute, perDay: config.perDay }),
  translate: config.paidApiEnabled
    ? createOpenAITranslator({ apiKey: config.openaiApiKey, model: config.openaiModel })
    : null,
});

// 공개 채널 자동 참여 (새 채널·보관 해제 채널).
if (config.autoJoinPublic) registerAutoJoin(app, { logger });

// 팀원이 계정을 나가거나 앱을 제거하면 그 사람 토큰을 즉시 지운다.
app.event('tokens_revoked', async ({ event }) => {
  for (const uid of event?.tokens?.oauth ?? []) userTokens?.delete(uid, 'app_removed');
});
app.event('user_change', async ({ event }) => {
  if (event?.user?.deleted) userTokens?.delete(event.user.id, 'account_deactivated');
});

app.error(async (err) => {
  logger.error(`처리 중 오류: ${err.code ?? err.name}`);
});

const web = http.createServer(async (req, res) => {
  // DM 연결(OAuth) 경로를 먼저 처리한다.
  if (oauthHandle && await oauthHandle(req, res)) return;
  if (req.url?.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      transport: 'socket',
      socketConnected: state.socketConnected,
      paidApiEnabled: config.paidApiEnabled,
      dmEnabled: config.dmEnabled,
      usersWithLanguage: prefs.size(),
      usersConnectedForDm: userTokens?.size() ?? 0,
      uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    }));
    return;
  }
  res.writeHead(404).end();
});

async function main() {
  // 시작 확인은 재시도를 줄여, 네트워크가 막혀 있으면 오래 멈추지 않고 알린다.
  console.log('Slack 봇 토큰 확인 중…');
  const probe = new webApi.WebClient(config.botToken, { timeout: 10_000, retryConfig: { retries: 1 } });
  const auth = await probe.auth.test();
  if (auth.team_id !== config.teamId) {
    console.error(`[config] 봇 토큰의 워크스페이스(${auth.team_id})가 SLACK_TEAM_ID 와 다릅니다.`);
    process.exit(1);
  }
  // DM 연결을 쓰면 OAuth 콜백을 밖에서 받아야 하므로 공개 포트(0.0.0.0:$PORT)로 연다.
  // 안 쓰면 이 PC 에서만 접근 가능한 127.0.0.1 로 둔다.
  const port = config.dmEnabled ? Number(process.env.PORT || config.healthPort) : config.healthPort;
  const host = config.dmEnabled ? '0.0.0.0' : config.healthHost;
  web.listen(port, host, () => {
    console.log(`web: http://${host}:${port}/health${config.dmEnabled ? ` (DM 연결: ${config.installUrl})` : ''}`);
  });
  await app.start();
  if (config.autoJoinPublic) {
    // 실패해도 번역 기능은 계속 돈다. 권한(channels:read, channels:join)이 없으면 로그만 남긴다.
    try {
      const r = await joinAllPublicChannels(app.client, logger);
      console.log(`공개 채널 자동 참여: 새로 ${r.joined}, 이미/건너뜀 ${r.skipped}, 실패 ${r.failed}`);
    } catch (err) {
      console.error(`공개 채널 자동 참여 실패: ${err.data?.error ?? err.code ?? err.message}`);
    }
  }
  console.log(`BLB Translator 시작 (유료 번역 API: ${config.paidApiEnabled ? `켜짐, ${config.openaiModel}` : '꺼짐'}). 종료: Ctrl+C`);
}

async function shutdown() {
  web.close();
  await app.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  const reason = err.data?.error ?? err.code ?? err.message;
  const hint = {
    slack_webapi_request_error: 'Slack 에 접속하지 못했습니다. 인터넷·방화벽을 확인하세요.',
    invalid_auth: 'SLACK_BOT_TOKEN 이 올바르지 않습니다. 앱을 다시 설치했다면 새 토큰으로 바꾸세요.',
    not_authed: 'SLACK_BOT_TOKEN 이 비어 있습니다.',
  }[reason];
  console.error(`시작 실패: ${reason}${hint ? ` — ${hint}` : ''}`);
  process.exit(1);
});
