// Slack 이벤트 처리. Bolt 앱 객체와 번역 함수는 주입받아 테스트에서 가짜로 바꿀 수 있다.
import {
  extractMessageText,
  selectContext,
  packMetadata,
  unpackMetadata,
  findLanguage,
} from './core.mjs';
import { translateView, readControls, ACTION_LANGUAGE, ACTION_CONTEXT } from './views.mjs';

export const SHORTCUT_ID = 'translate_message';

const CONTEXT_NOTES = {
  none: '스레드의 첫 메시지이거나 스레드가 아니라서 이 메시지만 번역했습니다. / No earlier thread messages; translated this message only.',
  denied: '문맥을 읽을 권한이 없어 이 메시지만 번역했습니다. / No permission to read the thread; translated this message only.',
  failed: '문맥을 읽지 못해 이 메시지만 번역했습니다. / Could not read the thread; translated this message only.',
};

// 스레드 앞선 메시지를 읽는다. 실패해도 번역은 계속한다.
export async function loadContext(client, meta) {
  if (!meta.threadTs || meta.threadTs === meta.ts) return { context: [], note: CONTEXT_NOTES.none };
  try {
    const res = await client.conversations.replies({ channel: meta.channel, ts: meta.threadTs, limit: 50 });
    const context = selectContext(res.messages, meta.ts);
    if (!context.length) return { context, note: CONTEXT_NOTES.none };
    return { context, note: `스레드 앞선 메시지 ${context.length}개를 참고했습니다. / Used ${context.length} earlier thread message(s) as context.` };
  } catch (err) {
    const code = err?.data?.error;
    const denied = ['missing_scope', 'not_in_channel', 'channel_not_found', 'not_allowed_token_type'].includes(code);
    return { context: [], note: denied ? CONTEXT_NOTES.denied : CONTEXT_NOTES.failed, errorCode: code ?? 'unknown' };
  }
}

export function registerHandlers(app, { config, translate, limiter, logger }) {
  const latestRequest = new Map(); // view id → 가장 최근 요청 번호. 늦게 끝난 옛 번역이 새 결과를 덮지 않게 한다.
  let requestSeq = 0;

  const sameTeam = (body) => body?.team?.id === config.teamId;

  app.shortcut(SHORTCUT_ID, async ({ ack, body, client }) => {
    await ack();
    if (!sameTeam(body)) {
      logger.warn('다른 워크스페이스의 요청을 무시했습니다.');
      return;
    }
    const message = body.message ?? {};
    const text = extractMessageText(message);
    const metadata = packMetadata({
      channel: body.channel?.id,
      ts: message.ts ?? body.message_ts,
      threadTs: message.thread_ts,
      text,
    });
    const meta = unpackMetadata(metadata);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: translateView({ metadata, original: meta.text, truncated: meta.truncated, status: 'idle' }),
    });
  });

  const onControlChange = async ({ ack, body, client }) => {
    await ack();
    if (!sameTeam(body)) return;
    const view = body.view;
    const meta = unpackMetadata(view.private_metadata);
    const { language, useContext } = readControls(view);
    const base = { metadata: view.private_metadata, original: meta.text, truncated: meta.truncated, language, useContext };
    if (!findLanguage(language)) return; // 언어를 아직 고르지 않았으면 문맥 체크만 바뀐 것

    const seq = ++requestSeq;
    latestRequest.set(view.id, seq);
    const isLatest = () => latestRequest.get(view.id) === seq;
    const update = (v) => client.views.update({ view_id: view.id, view: translateView({ ...base, ...v }) });

    await update({ status: 'loading' });

    const { context, note, errorCode } = useContext ? await loadContext(client, meta) : { context: [], note: null };
    if (errorCode) logger.info(`문맥 읽기 실패: ${errorCode}`);

    let result;
    let status = 'done';
    if (!config.paidApiEnabled) {
      result = `_(미리보기 / Preview)_ 유료 번역 API가 꺼져 있어 실제 번역은 하지 않았습니다. / Paid translation API is off; nothing was translated.`;
    } else {
      const allowed = limiter.check(body.user.id);
      if (!allowed.ok) {
        status = 'error';
        result = allowed.reason === 'day'
          ? '오늘 번역 한도에 도달했습니다. 관리자에게 알려 주세요. / Daily translation limit reached.'
          : '요청이 너무 잦습니다. 1분 뒤 다시 시도해 주세요. / Too many requests; try again in a minute.';
      } else {
        try {
          result = await translate({ text: meta.text, targetCode: language, context });
        } catch (err) {
          logger.error(`번역 실패: ${err.message}`);
          status = 'error';
          result = '번역에 실패했습니다. 잠시 뒤 다시 시도해 주세요. / Translation failed; please try again.';
        }
      }
    }

    if (!isLatest()) return;
    latestRequest.delete(view.id);
    await update({ status, result, note });
  };

  app.action(ACTION_LANGUAGE, onControlChange);
  app.action(ACTION_CONTEXT, onControlChange);
}
