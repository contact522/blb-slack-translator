// OpenAI Responses API 호출. PAID_API_ENABLED=true 일 때만 쓰인다.
// Lark 번역봇(blb-lark-translator)과 같은 방식: 구조화 출력, 오염된 출력 감지 후 1회 재시도, 429 재시도.
import { buildTranslationPrompt, isWrongScript } from './core.mjs';

export class TranslationError extends Error {}

// 모델이 번역 대신 지시문·스키마 이야기를 내놓은 경우를 잡는다. 원문에 같은 표현이 있으면 통과.
const SUSPICIOUS = [
  /malformed\s+json/i,
  /\bmust\s+output\b/i,
  /\bassistant\s+content(?:\s+type)?\b/i,
  /\bexact\s+schema\b/i,
  /\b(?:system|developer|assistant)\s+(?:message|content|role)\b/i,
  /(?:\}\s*){3,}/,
];

export function isSuspiciousTranslation(original, translated) {
  if (typeof translated !== 'string' || !translated.trim()) return true;
  return SUSPICIOUS.some((p) => p.test(translated) && !p.test(original));
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  for (const item of data.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.type === 'output_text' && typeof c.text === 'string') return c.text;
    }
  }
  return '';
}

export function createOpenAITranslator({
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  async function request(body) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let res;
      try {
        res = await fetchImpl('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new TranslationError(`network: ${err.name}`);
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;

      const code = data?.error?.code ?? data?.error?.type ?? '';
      if (res.status !== 429) throw new TranslationError(`http ${res.status} ${code}`.trim());
      if (/insufficient_quota|billing|usage_limit/i.test(code)) throw new TranslationError('quota');
      if (attempt === 2) throw new TranslationError('rate_limited');
      await sleep(1200 * 2 ** attempt);
    }
    throw new TranslationError('rate_limited');
  }

  return async function translate({ text, targetCode, context }) {
    const { system, user } = buildTranslationPrompt({ text, targetCode, context });
    const body = {
      model,
      reasoning: { effort: 'none' },
      instructions: system,
      input: user,
      text: {
        format: {
          type: 'json_schema',
          name: 'translation',
          strict: true,
          schema: {
            type: 'object',
            properties: { translation: { type: 'string' }, reused_existing: { type: 'boolean' } },
            required: ['translation', 'reused_existing'],
            additionalProperties: false,
          },
        },
      },
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const data = await request(body);
      let out;
      let reused = false;
      try {
        const parsed = JSON.parse(extractOutputText(data));
        out = String(parsed.translation ?? '').trim();
        reused = parsed.reused_existing === true;
      } catch {
        out = '';
      }
      // 다국어 원문에서 내 언어 문단을 그대로 옮긴 경우는 결과 아래에 알린다(handlers). 그 외 호출부는 문자열처럼 쓴다.
      if (!isSuspiciousTranslation(text, out) && !isWrongScript(out, targetCode)) return reused ? { translation: out, reusedExisting: true } : out;
    }
    throw new TranslationError('rejected output');
  };
}
