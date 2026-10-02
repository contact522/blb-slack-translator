// Slack 이벤트 처리. Bolt 앱 객체와 번역 함수는 주입받아 테스트에서 가짜로 바꿀 수 있다.
//
// 흐름
// - 메시지 ⋯ → 번역: 저장된 내 언어로 바로 번역해 대화 안에 「나에게만 표시」로 보인다.
//   처음 쓰는 사람은 언어를 한 번 고르는 모달이 먼저 뜬다.
// - 🌐 반응: 봇이 들어가 있는 채널에서 같은 번역을 한다 (마우스 올림 아이콘 줄에서 한 번 클릭).
// - 결과 아래 「다른 언어로 보기」는 이번만, 「기본 언어」는 저장값을 바꾼다.
import crypto from 'node:crypto';
import { extractMessageText, selectContext, findLanguage } from './core.mjs';
import {
  resultMessage,
  expiredMessage,
  prefView,
  readPref,
  PREF_CALLBACK_ID,
  ACTION_RETRANSLATE,
  ACTION_CHANGE_DEFAULT,
  RESULT_BLOCK_PREFIX,
} from './views.mjs';

export const SHORTCUT_ID = 'translate_message';
export const MAX_SOURCE_CHARS = 4000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;
// 같은 메시지·같은 언어는 다시 번역하지 않고 저장된 결과를 보여 준다(비용 0, 즉시).
// 메모리에만 둔다(본문을 디스크에 쌓지 않는다). 재시작하면 비워진다. 글을 고치면 원문이 달라져 새로 번역한다.
const DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 스레드 앞선 메시지를 읽는다. 권한이 없거나 스레드가 아니면 빈 문맥으로 계속한다.
export async function loadContext(client, meta) {
  if (!meta.threadTs || meta.threadTs === meta.ts) return { context: [] };
  try {
    const res = await client.conversations.replies({ channel: meta.channel, ts: meta.threadTs, limit: 50 });
    return { context: selectContext(res.messages, meta.ts) };
  } catch (err) {
    return { context: [], errorCode: err?.data?.error ?? 'unknown' };
  }
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`response_url ${res.status}`);
}

// 연결 안 한 사람이 DM 에서 🌐 를 눌렀을 때 보내는 안내.
function connectPrompt(installUrl) {
  return {
    text: 'DM 번역을 켜려면 한 번 연결해 주세요 / Connect once to translate in DMs',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: 'DM 에서 🌐 번역을 쓰려면 한 번만 연결해 주세요. 연결하면 이 앱이 회사 번역을 위해 내 DM 메시지를 읽을 수 있습니다.\nConnect once to use 🌐 translation in DMs. This lets the app read your DM messages for translation.' } },
      { type: 'actions', elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: '🔗 연결 / Connect' }, url: installUrl }] },
    ],
  };
}

export function registerHandlers(app, {
  config, translate, limiter, logger, prefs,
  userTokens = null,
  makeClient = (token) => new (app.client.constructor)(token),
  respond = postJson, now = () => Date.now(),
}) {
  // 원문 기록. 버튼(다른 언어로 보기 등)을 누를 때 원문이 다시 필요하다. 메모리 보관이라 재시작하면 사라진다.
  const sources = new Map();
  // 반응 중복 방지 (봇 이벤트 + 사용자 이벤트 동시 도착). 키→시각.
  const recentReactions = new Map();
  const remember = (entry) => {
    const t = now();
    for (const [k, v] of sources) {
      if (sources.size < CACHE_MAX && t - v.at < CACHE_TTL_MS) break;
      sources.delete(k); // Map 은 넣은 순서라 앞쪽이 가장 오래된 것
    }
    const id = crypto.randomBytes(6).toString('hex');
    sources.set(id, { ...entry, at: t });
    return id;
  };
  const recall = (id) => {
    const e = sources.get(id);
    if (!e || now() - e.at > CACHE_TTL_MS) return null;
    return e;
  };

  // 번역 결과 재사용. 키: 대화방·메시지·언어·원문 해시.
  const done = new Map();
  const doneKey = (entry, language) =>
    `${entry.channel}:${entry.ts}:${language}:${crypto.createHash('sha1').update(entry.text).digest('hex')}`;
  const reuse = (key) => {
    const e = done.get(key);
    if (!e || now() - e.at > DONE_TTL_MS) return null;
    return e.out;
  };
  const keep = (key, out) => {
    done.delete(key);
    done.set(key, { out, at: now() });
    for (const k of done.keys()) {
      if (done.size <= CACHE_MAX) break;
      done.delete(k);
    }
  };

  const sameTeam = (teamId) => teamId === config.teamId;

  async function translateText(client, userId, entry, language) {
    if (!config.paidApiEnabled) {
      return { status: 'done', result: '_(미리보기 / Preview)_ 유료 번역 API가 꺼져 있어 실제 번역은 하지 않았습니다. / Paid translation API is off; nothing was translated.' };
    }
    const key = doneKey(entry, language);
    const saved = reuse(key);
    if (saved) return saved;
    const allowed = limiter.check(userId);
    if (!allowed.ok) {
      return {
        status: 'error',
        result: allowed.reason === 'day'
          ? '오늘 번역 한도에 도달했습니다. 관리자에게 알려 주세요. / Daily translation limit reached.'
          : '요청이 너무 잦습니다. 1분 뒤 다시 시도해 주세요. / Too many requests; try again in a minute.',
      };
    }
    const { context, errorCode } = await loadContext(client, entry);
    if (errorCode) logger.info(`문맥 읽기 생략: ${errorCode}`);
    try {
      const result = await translate({ text: entry.text, targetCode: language, context });
      const note = context.length ? `스레드 앞 메시지 ${context.length}개를 참고했습니다. / Used ${context.length} earlier thread message(s).` : null;
      const out = { status: 'done', result, note };
      keep(key, out);
      return out;
    } catch (err) {
      logger.error(`번역 실패: ${err.message}`);
      return { status: 'error', result: '번역에 실패했습니다. 잠시 뒤 다시 시도해 주세요. / Translation failed; please try again.' };
    }
  }

  // 대화 안에 「나에게만 표시」로 보낸다. 봇이 없는 대화방(DM 등)이면 response_url 로 보낸다.
  async function deliver(client, entry, userId, message) {
    try {
      await client.chat.postEphemeral({
        channel: entry.channel,
        user: userId,
        // 원글이든 댓글이든 그 글의 댓글 창 안에 보인다.
        thread_ts: entry.threadTs ?? undefined,
        ...message,
      });
      return;
    } catch (err) {
      const code = err?.data?.error ?? err.message;
      if (!entry.responseUrl) {
        logger.warn(`결과 전달 실패: ${code}`);
        return;
      }
      logger.warn(`봇으로 못 보내 response_url 로 전달: ${code}`);
    }
    try {
      await respond(entry.responseUrl, { response_type: 'ephemeral', thread_ts: entry.threadTs ?? undefined, ...message });
    } catch (err) {
      logger.warn(`결과 전달 실패: ${err.message}`);
    }
  }

  async function run(client, { id, entry, userId, language, replaceUrl }) {
    const out = await translateText(client, userId, entry, language);
    const message = resultMessage({ id, language, truncated: entry.truncated, ...out });
    // DM 에서 아직 연결 안 한 사람이면, 결과 아래에 「🌐 연결」 버튼을 붙인다.
    // 연결하면 다음부터 이 DM 에서 🌐 한 번으로 번역된다(반응은 DM 에선 연결자만 온다).
    if (entry.channel?.startsWith('D') && config.installUrl && userTokens && !userTokens.has(userId)) {
      message.blocks = [
        ...message.blocks,
        { type: 'context', elements: [{ type: 'mrkdwn', text: '💡 이 DM 에서 🌐 한 번으로 번역하려면 연결하세요. / Connect to use 🌐 one-tap in this DM.' }] },
        { type: 'actions', elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: '🌐 연결 / Connect' }, url: config.installUrl }] },
      ];
    }
    if (replaceUrl) {
      await respond(replaceUrl, { replace_original: true, response_type: 'ephemeral', ...message })
        .catch((err) => logger.warn(`결과 교체 실패: ${err.message}`));
    } else {
      await deliver(client, entry, userId, message);
    }
  }

  function makeEntry({ channel, message, responseUrl }) {
    const full = extractMessageText(message);
    return {
      channel,
      ts: message.ts,
      // 결과는 항상 그 글의 댓글 창 안에 둔다(대표 요청). 댓글이 없는 글도 자기 ts 를 스레드로 쓴다.
      threadTs: message.thread_ts ?? message.ts ?? null,
      text: full.slice(0, MAX_SOURCE_CHARS),
      truncated: full.length > MAX_SOURCE_CHARS,
      responseUrl: responseUrl ?? null,
    };
  }

  // 공통 시작점: 저장된 언어가 있으면 바로 번역, 없으면 언어 고르기 모달.
  async function start(client, { userId, entry, triggerId }) {
    if (!entry.text) {
      await deliver(client, entry, userId, { text: '번역할 글이 없습니다. / Nothing to translate.' });
      return;
    }
    const id = remember(entry);
    const language = prefs.get(userId);
    if (findLanguage(language)) {
      await run(client, { id, entry, userId, language });
      return;
    }
    if (triggerId) {
      await client.views.open({ trigger_id: triggerId, view: prefView({ metadata: JSON.stringify({ id }), first: true }) });
      return;
    }
    // 반응으로 시작해 모달을 열 수 없으면 버튼으로 안내한다.
    await deliver(client, entry, userId, {
      text: '번역 언어를 먼저 골라 주세요 / Choose your language first',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '번역을 받을 언어를 먼저 골라 주세요. / Please choose your translation language first.' } },
        { type: 'actions', block_id: `${RESULT_BLOCK_PREFIX}${id}`, elements: [{ type: 'button', action_id: ACTION_CHANGE_DEFAULT, text: { type: 'plain_text', text: '⚙ 언어 고르기 / Choose language' }, value: id }] },
      ],
    });
  }

  app.shortcut(SHORTCUT_ID, async ({ ack, body, client }) => {
    await ack();
    if (!sameTeam(body?.team?.id)) {
      logger.warn('다른 워크스페이스의 요청을 무시했습니다.');
      return;
    }
    const entry = makeEntry({ channel: body.channel?.id, message: body.message ?? {}, responseUrl: body.response_url });
    await start(client, { userId: body.user.id, entry, triggerId: body.trigger_id });
  });

  // 반응한 메시지 하나를 읽는다. 봇 토큰(채널)과 사용자 토큰(DM) 양쪽에서 쓴다.
  async function readReactedMessage(reader, channel, ts) {
    const res = await reader.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 });
    let message = res.messages?.find((m) => m.ts === ts);
    if (!message) {
      // 스레드 답글은 history 에 없다. replies 로 찾는다.
      const r = await reader.conversations.replies({ channel, ts, limit: 1 });
      message = r.messages?.find((m) => m.ts === ts);
    }
    return message ?? null;
  }

  // 🌐 반응.
  // - 채널: 봇이 참여한 곳의 이벤트만 온다. 봇 토큰으로 읽고 봇으로 나에게만 보낸다.
  // - DM/그룹DM: 반응한 본인이 연결(userTokens)돼 있으면 그 사람 토큰으로 읽고 그 사람으로서 나에게만 보낸다.
  app.event('reaction_added', async ({ event, body, client }) => {
    if (!sameTeam(body?.team_id)) return;
    if (event.reaction !== config.reaction || event.item?.type !== 'message') return;
    const { channel, ts } = event.item;
    const isDm = channel.startsWith('D'); // D=DM/그룹DM 채널 id 접두. 채널은 C/G.

    // 봇 이벤트와 사용자 이벤트가 둘 다 구독돼 있으면, 봇이 든 채널에서 연결된 사람이 반응하면
    // 같은 반응이 두 번 온다. 짧은 시간 안의 같은 (대화방·메시지·사람·이모지)는 한 번만 처리.
    const dedupKey = `${channel}:${ts}:${event.user}:${event.reaction}`;
    if (recentReactions.has(dedupKey)) return;
    recentReactions.set(dedupKey, now());
    for (const [k, t] of recentReactions) {
      if (now() - t > 15_000) recentReactions.delete(k);
    }

    const userToken = userTokens?.get(event.user) ?? null;
    const userClient = userToken ? makeClient(userToken) : null;

    // 채널: 봇 토큰으로 먼저 읽는다(공개 채널은 자동 참여, 비공개는 /invite 한 곳).
    // 봇이 못 읽으면(봇 없는 채널·그룹DM) 연결된 본인 토큰으로 읽고 본인으로서 나에게만 보낸다.
    // DM: 봇은 못 들어가므로 바로 본인 토큰.
    let message;
    let sender = client;
    try {
      let readByBot = false;
      if (!isDm) {
        try {
          message = await readReactedMessage(client, channel, ts);
          readByBot = true;
        } catch (err) {
          if (!userClient) throw err;
        }
      }
      if (!readByBot) {
        if (!userClient) throw Object.assign(new Error('no_reader'), { data: { error: 'no_reader' } });
        message = await readReactedMessage(userClient, channel, ts);
        sender = userClient;
        userTokens.record(event.user, isDm ? 'dm' : 'channel', channel);
      }
    } catch (err) {
      const code = err?.data?.error ?? err.message;
      // DM 인데 본인이 연결 안 했으면 연결 링크를 안내한다(봇 토큰으로 보냄).
      if (isDm && !userToken && config.installUrl) {
        await deliver(client, { channel, ts, threadTs: null }, event.user, connectPrompt(config.installUrl))
          .catch(() => {});
        return;
      }
      logger.warn(`반응한 메시지를 읽지 못함: ${code}`);
      return;
    }
    if (!message) return;

    const entry = makeEntry({ channel, message });
    await start(sender, { userId: event.user, entry });
  });

  app.action(ACTION_RETRANSLATE, async ({ ack, body, action, client }) => {
    await ack();
    if (!sameTeam(body?.team?.id)) return;
    const id = action.block_id.slice(RESULT_BLOCK_PREFIX.length);
    const entry = recall(id);
    if (!entry) {
      await respond(body.response_url, { replace_original: true, response_type: 'ephemeral', ...expiredMessage() }).catch(() => {});
      return;
    }
    await run(client, { id, entry, userId: body.user.id, language: action.selected_option.value, replaceUrl: body.response_url });
  });

  app.action(ACTION_CHANGE_DEFAULT, async ({ ack, body, action, client }) => {
    await ack();
    if (!sameTeam(body?.team?.id)) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: prefView({
        metadata: JSON.stringify({ id: action.value, replaceUrl: body.response_url ?? null }),
        current: prefs.get(body.user.id),
      }),
    });
  });

  app.view(PREF_CALLBACK_ID, async ({ ack, body, view, client }) => {
    await ack();
    if (!sameTeam(body?.team?.id)) return;
    const language = readPref(view);
    if (!findLanguage(language)) return;
    prefs.set(body.user.id, language);
    const { id, replaceUrl } = JSON.parse(view.private_metadata || '{}');
    const entry = id ? recall(id) : null;
    if (entry) await run(client, { id, entry, userId: body.user.id, language, replaceUrl });
  });
}
