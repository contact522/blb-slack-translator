// Gemini REST API 호출. PAID_API_ENABLED=true 일 때만 쓰인다.
import { buildTranslationPrompt } from './core.mjs';

export class TranslationError extends Error {}

export function createGeminiTranslator({ apiKey, model, fetchImpl = fetch, timeoutMs = 20_000 }) {
  return async function translate({ text, targetCode, context }) {
    const { system, user } = buildTranslationPrompt({ text, targetCode, context });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TranslationError(`network: ${err.name}`);
    }
    if (!res.ok) throw new TranslationError(`http ${res.status}`);

    const data = await res.json();
    const out = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!out) throw new TranslationError(`empty (${data.candidates?.[0]?.finishReason ?? 'no candidate'})`);
    return out;
  };
}
