// 진입점. Socket Mode 로 Slack 에 연결하고 127.0.0.1 에 /health 를 연다.
import http from 'node:http';
import bolt from '@slack/bolt';
import { loadConfig } from './config.mjs';
import { createRateLimiter } from './core.mjs';
import { createOpenAITranslator } from './translator.mjs';
import { registerHandlers } from './handlers.mjs';
import { createPrefStore } from './prefs.mjs';
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

registerHandlers(app, {
  config,
  logger,
  prefs,
  limiter: createRateLimiter({ perUserPerMinute: config.perUserPerMinute, perDay: config.perDay }),
  translate: config.paidApiEnabled
    ? createOpenAITranslator({ apiKey: config.openaiApiKey, model: config.openaiModel })
    : null,
});

app.error(async (err) => {
  logger.error(`처리 중 오류: ${err.code ?? err.name}`);
});

const health = http.createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    transport: 'socket',
    socketConnected: state.socketConnected,
    paidApiEnabled: config.paidApiEnabled,
    usersWithLanguage: prefs.size(),
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
  }));
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
  health.listen(config.healthPort, config.healthHost, () => {
    console.log(`health: http://${config.healthHost}:${config.healthPort}/health`);
  });
  await app.start();
  console.log(`BLB Translator 시작 (유료 번역 API: ${config.paidApiEnabled ? `켜짐, ${config.openaiModel}` : '꺼짐'}). 종료: Ctrl+C`);
}

async function shutdown() {
  health.close();
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
