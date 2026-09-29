// 환경변수를 읽어 검증한다. 비밀값은 오류 메시지에 넣지 않는다.

function bool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, fallback) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env = process.env) {
  const errors = [];
  const botToken = env.SLACK_BOT_TOKEN ?? '';
  const appToken = env.SLACK_APP_TOKEN ?? '';
  const teamId = env.SLACK_TEAM_ID ?? '';
  const paidApiEnabled = bool(env.PAID_API_ENABLED, false);
  const openaiApiKey = env.OPENAI_API_KEY ?? '';

  if (!botToken.startsWith('xoxb-')) errors.push('SLACK_BOT_TOKEN 이 없거나 xoxb- 로 시작하지 않습니다.');
  if (!appToken.startsWith('xapp-')) errors.push('SLACK_APP_TOKEN 이 없거나 xapp- 로 시작하지 않습니다.');
  if (!/^T[A-Z0-9]+$/.test(teamId)) errors.push('SLACK_TEAM_ID 가 없거나 형식이 맞지 않습니다.');
  if (paidApiEnabled && !openaiApiKey) errors.push('PAID_API_ENABLED=true 인데 OPENAI_API_KEY 가 없습니다.');

  return {
    errors,
    botToken,
    appToken,
    teamId,
    paidApiEnabled,
    openaiApiKey,
    openaiModel: env.OPENAI_MODEL || 'gpt-6-luna',
    perUserPerMinute: int(env.RATE_LIMIT_PER_USER_PER_MINUTE, 10),
    perDay: int(env.RATE_LIMIT_PER_DAY, 500),
    healthHost: env.HEALTH_HOST || '127.0.0.1',
    healthPort: int(env.HEALTH_PORT, 3000),
  };
}
