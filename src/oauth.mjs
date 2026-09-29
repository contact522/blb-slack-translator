// 「BLB Translator 연결」 링크. 팀원 각자가 한 번 눌러 허락하면 DM 에서도 🌐 번역이 된다.
// /slack/install → Slack 허락 화면 → /slack/oauth_redirect 에서 사용자 토큰을 받아 암호화 저장.
import crypto from 'node:crypto';

// DM·그룹 DM 의 🌐 반응을 받고, 그 메시지를 읽고, 결과를 나에게만 보이게 보내는 데 필요한 최소 권한.
export const USER_SCOPES = ['im:history', 'mpim:history', 'reactions:read', 'chat:write'];
export const INSTALL_PATH = '/slack/install';
export const REDIRECT_PATH = '/slack/oauth_redirect';
const STATE_TTL_MS = 10 * 60 * 1000;

// CSRF 방지용 state. 링크 위조를 막고 10분 뒤 만료된다.
export function signState(secret, now = Date.now()) {
  const payload = `${now}.${crypto.randomBytes(8).toString('hex')}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

export function verifyState(secret, state, now = Date.now()) {
  const parts = String(state ?? '').split('.');
  if (parts.length !== 3) return false;
  const [ts, nonce, mac] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${nonce}`).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return now - Number(ts) < STATE_TTL_MS;
}

function page(title, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:14vh auto;padding:0 20px;line-height:1.7;color:#1d1c1d}h1{font-size:22px}.small{color:#616061;font-size:14px}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}

export function createOAuthRoutes({ config, userTokens, fetchImpl = fetch, logger }) {
  const redirectUri = `${config.publicUrl}${REDIRECT_PATH}`;

  function installUrl() {
    const q = new URLSearchParams({
      client_id: config.clientId,
      user_scope: USER_SCOPES.join(','),
      redirect_uri: redirectUri,
      state: signState(config.stateSecret),
      team: config.teamId,
    });
    return `https://slack.com/oauth/v2/authorize?${q}`;
  }

  async function exchange(code) {
    const res = await fetchImpl('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.json();
  }

  // 처리했으면 true. 나머지 경로는 호출한 쪽(health 등)이 처리한다.
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const send = (status, html) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    };

    if (url.pathname === INSTALL_PATH) {
      res.writeHead(302, { location: installUrl() });
      res.end();
      return true;
    }
    if (url.pathname !== REDIRECT_PATH) return false;

    if (url.searchParams.get('error')) {
      send(200, page('연결하지 않았습니다', '<p>허용하지 않아 연결되지 않았습니다. 필요하면 링크를 다시 눌러 주세요.</p><p class="small">Not connected. Open the link again if you change your mind.</p>'));
      return true;
    }
    if (!verifyState(config.stateSecret, url.searchParams.get('state'))) {
      send(400, page('링크가 만료됐습니다', '<p>연결 링크를 다시 눌러 주세요.</p><p class="small">The link expired. Please open it again.</p>'));
      return true;
    }
    let data;
    try {
      data = await exchange(url.searchParams.get('code') ?? '');
    } catch (err) {
      logger.warn(`사용자 연결 실패: ${err.name}`);
      send(502, page('연결하지 못했습니다', '<p>잠시 뒤 다시 시도해 주세요.</p><p class="small">Please try again later.</p>'));
      return true;
    }
    const user = data?.authed_user;
    if (!data?.ok || !user?.access_token || data?.team?.id !== config.teamId) {
      logger.warn(`사용자 연결 거절: ${data?.error ?? 'team_or_token_mismatch'}`);
      send(400, page('연결하지 못했습니다', '<p>YWH 워크스페이스 계정으로 다시 시도해 주세요.</p><p class="small">Please try again with your YWH workspace account.</p>'));
      return true;
    }
    userTokens.set(user.id, user.access_token, user.scope);
    send(200, page('연결됐습니다 ✅', '<p>이제 DM 에서도 메시지에 🌐 를 달면 번역이 나에게만 보입니다. 이 창은 닫아도 됩니다.</p><p class="small">Connected. React with 🌐 in DMs to get a translation only you can see. You can close this page.</p><p class="small">연결 해제: 워크스페이스 설정 → 앱에서 BLB Translator 제거.</p>'));
    return true;
  };
}
