// Block Kit 화면. 번역 결과는 대화 안에 「나에게만 표시」 메시지로, 언어 설정은 작은 모달로 보인다.
import { LANGUAGES, findLanguage } from './core.mjs';

export const PREF_CALLBACK_ID = 'set_default_language';
export const ACTION_RETRANSLATE = 'retranslate';
export const ACTION_CHANGE_DEFAULT = 'change_default';
export const RESULT_BLOCK_PREFIX = 'r:'; // 결과 메시지의 버튼 줄 block_id = r:<원문 기록 id>
const PREF_BLOCK = 'lang';
const SECTION_LIMIT = 2900; // Slack section text 한도 3000자

function clip(text) {
  return text.length > SECTION_LIMIT ? `${text.slice(0, SECTION_LIMIT)}…` : text;
}

function option(lang) {
  return { text: { type: 'plain_text', text: lang.label }, value: lang.code };
}

// 번역 결과 메시지. 아래에 「다른 언어로 보기」와 「기본 언어 바꾸기」를 붙인다.
export function resultMessage({ id, language, result, status = 'done', note, truncated }) {
  const lang = findLanguage(language);
  const blocks = [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:globe_with_meridians: *${lang?.label ?? language}* 번역 / Translation` }],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: status === 'error' ? `:warning: ${result}` : clip(result) },
    },
  ];
  const notes = [];
  if (truncated) notes.push('원문이 길어 앞부분만 번역했습니다. / Long message: only the first part was translated.');
  if (note) notes.push(note);
  if (notes.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: notes.join('\n') }] });
  blocks.push({
    type: 'actions',
    block_id: `${RESULT_BLOCK_PREFIX}${id}`,
    elements: [
      {
        type: 'static_select',
        action_id: ACTION_RETRANSLATE,
        placeholder: { type: 'plain_text', text: '다른 언어로 보기 / Other language' },
        options: LANGUAGES.map(option),
      },
      {
        type: 'button',
        action_id: ACTION_CHANGE_DEFAULT,
        text: { type: 'plain_text', text: '⚙ 기본 언어 / My language' },
        value: id,
      },
    ],
  });
  // 알림·접근성용 대체 문구. 본문은 넣지 않는다.
  return { text: `${lang?.label ?? language} 번역 / Translation`, blocks };
}

// 원문 기록이 만료되어(서버 재시작 등) 다시 번역할 수 없을 때.
export function expiredMessage() {
  return {
    text: '다시 번역해 주세요 / Please translate again',
    blocks: [{
      type: 'section',
      text: { type: 'mrkdwn', text: '원문 기록이 만료됐습니다. 메시지의 ⋯ → 번역 / Translate 를 다시 눌러 주세요. / This translation expired. Please use ⋯ → Translate on the message again.' },
    }],
  };
}

// 기본 번역 언어 고르기. 처음 쓸 때와 「기본 언어 바꾸기」를 눌렀을 때 뜬다.
export function prefView({ metadata, current, first }) {
  const select = {
    type: 'static_select',
    action_id: PREF_BLOCK,
    placeholder: { type: 'plain_text', text: '언어 선택 / Choose language' },
    options: LANGUAGES.map(option),
  };
  const lang = findLanguage(current);
  if (lang) select.initial_option = option(lang);

  const intro = first
    ? '번역을 받을 언어를 한 번만 골라 주세요. 다음부터는 누르면 바로 이 언어로 번역됩니다.\nChoose the language you want translations in. You only need to do this once.'
    : '앞으로 번역을 받을 기본 언어를 고르세요.\nChoose your default translation language.';

  return {
    type: 'modal',
    callback_id: PREF_CALLBACK_ID,
    private_metadata: metadata,
    title: { type: 'plain_text', text: '번역 언어 / Language' },
    submit: { type: 'plain_text', text: '저장 / Save' },
    close: { type: 'plain_text', text: '닫기 / Close' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: intro } },
      { type: 'input', block_id: PREF_BLOCK, label: { type: 'plain_text', text: '내 언어 / My language' }, element: select },
    ],
  };
}

export function readPref(view) {
  return view?.state?.values?.[PREF_BLOCK]?.[PREF_BLOCK]?.selected_option?.value ?? null;
}
