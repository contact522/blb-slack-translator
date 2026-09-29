// Block Kit 모달. 번역 결과는 모달을 연 본인에게만 보인다.
import { LANGUAGES, findLanguage } from './core.mjs';

export const CALLBACK_ID = 'translate_modal';
export const ACTION_LANGUAGE = 'select_language';
export const ACTION_CONTEXT = 'toggle_context';
export const BLOCK_CONTROLS = 'controls';
const CONTEXT_VALUE = 'use_context';
const SECTION_LIMIT = 2900; // Slack section text 한도 3000자

function clip(text) {
  return text.length > SECTION_LIMIT ? `${text.slice(0, SECTION_LIMIT)}…` : text;
}

function option(lang) {
  return { text: { type: 'plain_text', text: lang.label }, value: lang.code };
}

export function translateView({ metadata, original, truncated, language, useContext, status, result, note }) {
  const contextOption = {
    text: { type: 'plain_text', text: '스레드 문맥 참고 / Use thread context' },
    value: CONTEXT_VALUE,
  };
  const select = {
    type: 'static_select',
    action_id: ACTION_LANGUAGE,
    placeholder: { type: 'plain_text', text: '언어 선택 / Choose language' },
    options: LANGUAGES.map(option),
  };
  const lang = findLanguage(language);
  if (lang) select.initial_option = option(lang);

  const checkboxes = { type: 'checkboxes', action_id: ACTION_CONTEXT, options: [contextOption] };
  if (useContext) checkboxes.initial_options = [contextOption];

  const blocks = [
    { type: 'context', elements: [{ type: 'mrkdwn', text: '*원문 / Original*' }] },
    { type: 'section', text: { type: 'mrkdwn', text: clip(original) || '_(본문 없음 / empty)_' } },
  ];
  if (truncated) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '원문이 길어 앞부분만 번역합니다. / Long message: only the first part is translated.' }],
    });
  }
  blocks.push(
    { type: 'divider' },
    { type: 'actions', block_id: BLOCK_CONTROLS, elements: [select, checkboxes] },
  );

  if (status === 'loading') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_${lang?.label ?? ''} 번역 중… / Translating…_` } });
  } else if (status === 'done') {
    blocks.push(
      { type: 'context', elements: [{ type: 'mrkdwn', text: `*번역 / Translation — ${lang.label}*` }] },
      { type: 'section', text: { type: 'mrkdwn', text: clip(result) } },
    );
  } else if (status === 'error') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:warning: ${result}` } });
  }
  if (note) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: note }] });

  return {
    type: 'modal',
    callback_id: CALLBACK_ID,
    private_metadata: metadata,
    title: { type: 'plain_text', text: '번역 / Translate' },
    close: { type: 'plain_text', text: '닫기 / Close' },
    blocks,
  };
}

// 모달의 현재 선택 상태를 읽는다.
export function readControls(view) {
  const values = view?.state?.values?.[BLOCK_CONTROLS] ?? {};
  return {
    language: values[ACTION_LANGUAGE]?.selected_option?.value ?? null,
    useContext: (values[ACTION_CONTEXT]?.selected_options ?? []).some((o) => o.value === CONTEXT_VALUE),
  };
}
