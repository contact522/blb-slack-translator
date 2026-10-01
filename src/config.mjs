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

  // DM 🌐 번역(사용자 연결). 이 값들이 모두 있어야 켜진다. 없으면 채널 🌐 와 ⋯→번역만 동작한다.
  const publicUrl = (env.PUBLIC_URL ?? '').replace(/\/$/, '');
  const clientId = env.SLACK_CLIENT_ID ?? '';
  const clientSecret = env.SLACK_CLIENT_SECRET ?? '';
  const tokenKey = env.TOKEN_KEY ?? '';
  const stateSecret = env.STATE_SECRET ?? '';
  const dmEnabled = Boolean(publicUrl && clientId && clientSecret && stateSecret && /^[0-9a-fA-F]{64}$/.test(tokenKey));

  if (!botToken.startsWith('xoxb-')) errors.push('SLACK_BOT_TOKEN 이 없거나 xoxb- 로 시작하지 않습니다.');
  if (!appToken.startsWith('xapp-')) errors.push('SLACK_APP_TOKEN 이 없거나 xapp- 로 시작하지 않습니다.');
  if (!/^T[A-Z0-9]+$/.test(teamId)) errors.push('SLACK_TEAM_ID 가 없거나 형식이 맞지 않습니다.');
  if (paidApiEnabled && !openaiApiKey) errors.push('PAID_API_ENABLED=true 인데 OPENAI_API_KEY 가 없습니다.');
  // DM 값이 일부만 있으면 설정 실수이므로 알린다(전부 없으면 그냥 DM 기능 꺼짐).
  const anyDm = publicUrl || clientId || clientSecret || tokenKey || stateSecret;
  if (anyDm && !dmEnabled) errors.push('DM 번역 설정이 일부만 있습니다. PUBLIC_URL·SLACK_CLIENT_ID·SLACK_CLIENT_SECRET·STATE_SECRET·TOKEN_KEY(64자리 16진수)를 모두 채우세요.');

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
    // 이 반응(이모지 이름)을 달면 번역한다. 마우스 올림 아이콘 줄에 넣어 두면 한 번 클릭.
    // 시작 시·새 공개 채널 생성 시 봇이 자동으로 들어간다. 끄려면 AUTO_JOIN_PUBLIC=false.
    autoJoinPublic: bool(env.AUTO_JOIN_PUBLIC, true),
    reaction: env.TRANSLATE_REACTION || 'globe_with_meridians',
    // 사람별 기본 언어 저장 위치. 서버에서는 Railway 볼륨(/data)에 둔다.
    dataDir: env.DATA_DIR || 'data',
    healthHost: env.HEALTH_HOST || '127.0.0.1',
    healthPort: int(env.HEALTH_PORT, 3000),
    // DM 🌐 번역(사용자 연결)
    dmEnabled,
    publicUrl,
    clientId,
    clientSecret,
    tokenKey,
    stateSecret,
    installUrl: dmEnabled ? `${publicUrl}/slack/install` : '',
  };
}
