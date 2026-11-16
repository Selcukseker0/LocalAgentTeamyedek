/**
 * Tek bir "LLM sağlayıcı" arayüzü.
 * LLM_PROVIDER=ollama | gemini | anthropic
 *
 * Hepsinde imza aynı: { system, prompt, json, temperature, numPredict } -> nesne veya metin.
 *
 * Davranış kuralları:
 *  - Birincil sağlayıcı hata verirse Ollama'ya düşülür (akış durmasın).
 *  - `LLM_NO_FALLBACK=1` ise düşülmez, hata hemen yukarı çıkar: yavaş yerel
 *    modelle 10 dakika beklemek yerine sorunu görmek daha iyi.
 *  - Aynı çalıştırmada bağlantı üst üste `LLM_BREAKER_FAILURES` kez koparsa
 *    sağlayıcı "devre dışı" sayılır; sonraki çağrılar boşuna 3×60 sn beklemez.
 */

import { config } from '../config.js';
import { askOllama } from './ollamaClient.js';
import {
  geminiGenerate,
  geminiOutputTokens,
  isGeminiConfigured,
  parseJsonContent,
  resolveGeminiModel
} from './gemini.js';

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const BREAKER_FAILURES = Number(process.env.LLM_BREAKER_FAILURES || 2);

// Çalıştırma boyunca sağlayıcı sağlığı (dosya ömrü = tek video üretimi)
const failures = new Map();

function breakerOpen(provider) {
  return (failures.get(provider) || 0) >= BREAKER_FAILURES;
}

function noteFailure(provider) {
  failures.set(provider, (failures.get(provider) || 0) + 1);
}

function resetFailures(provider) {
  failures.delete(provider);
}

async function askGemini({ system, prompt, json, temperature, numPredict }) {
  const { content, finishReason } = await geminiGenerate({
    body: {
      systemInstruction: { parts: [{ text: system || '' }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        // Düşünme token'ları da bu limite sayılır: 900 gibi düşük değer JSON'u kesiyordu
        maxOutputTokens: geminiOutputTokens(numPredict),
        ...(json ? { responseMimeType: 'application/json' } : {})
      }
    },
    label: 'gemini'
  });

  if (!json) return content;

  try {
    return parseJsonContent(content);
  } catch (err) {
    // MAX_TOKENS ile kesildiyse içerik yarım kalmıştır; yukarıda onarım denendi
    throw new Error(
      `${err.message}${finishReason === 'MAX_TOKENS' ? ' (yanıt MAX_TOKENS ile kesildi)' : ''}`
    );
  }
}

async function askAnthropic({ system, prompt, json, temperature, numPredict }) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY tanımlı değil');

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || ANTHROPIC_MODEL,
        max_tokens: Math.min(8192, Number(numPredict) || 1200),
        temperature,
        system,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(Number(process.env.ANTHROPIC_TIMEOUT_MS || 90_000))
    });
  } catch (err) {
    const cause = err?.cause?.code || err?.message || err?.name;
    throw new Error(`Anthropic bağlantı hatası: ${cause}`);
  }

  if (!res.ok) {
    throw new Error(`Anthropic API hatası (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  const content = (data?.content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();

  if (!content) throw new Error('Anthropic boş yanıt döndürdü');
  return json ? parseJsonContent(content) : content;
}

export function activeProvider() {
  return (process.env.LLM_PROVIDER || 'ollama').trim().toLowerCase();
}

/** Bir sağlayıcının bu çalıştırmada kullanılabilir olup olmadığını söyler (doctor/log için). */
export function providerState(provider = activeProvider()) {
  if (provider === 'ollama') return { usable: true, reason: null };
  if (provider === 'gemini') {
    if (!isGeminiConfigured()) return { usable: false, reason: 'GEMINI_API_KEY yok' };
    if (breakerOpen('gemini')) return { usable: false, reason: 'üst üste bağlantı hatası' };
    return { usable: true, reason: null };
  }
  if (provider === 'anthropic') {
    if (!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY)) {
      return { usable: false, reason: 'ANTHROPIC_API_KEY yok' };
    }
    if (breakerOpen('anthropic')) return { usable: false, reason: 'üst üste bağlantı hatası' };
    return { usable: true, reason: null };
  }
  return { usable: false, reason: `bilinmeyen sağlayıcı: ${provider}` };
}

export async function askLLM(options) {
  const provider = activeProvider();
  const noFallback = process.env.LLM_NO_FALLBACK === '1';

  if (provider === 'ollama') return askOllama(options);

  if (breakerOpen(provider)) {
    const why = `${provider} bu çalıştırmada ${BREAKER_FAILURES} kez üst üste başarısız oldu`;
    if (noFallback) throw new Error(`${why}; LLM_NO_FALLBACK=1 olduğu için durduruldu.`);
    console.warn(`[llm] ${why}; kalan adımlar Ollama ile yazılacak (yavaş olacak).`);
    return askOllama(options);
  }

  try {
    const result = provider === 'gemini' ? await askGemini(options) : await askAnthropic(options);
    resetFailures(provider);
    return result;
  } catch (err) {
    noteFailure(provider);
    if (noFallback) {
      throw new Error(
        `${provider} başarısız: ${err.message} — LLM_NO_FALLBACK=1 olduğu için Ollama'ya düşülmedi.`
      );
    }
    const rest = BREAKER_FAILURES - (failures.get(provider) || 0);
    console.warn(
      `[llm] ${provider} başarısız (${err.message}); Ollama'ya geçiliyor. ` +
      `Bu, yavaş yerel modelle 3-10 dakika sürebilir` +
      `${rest > 0 ? `; ${rest} hatadan sonra bu çalıştırmada tekrar denenmeyecek.` : '.'}`
    );
    return askOllama(options);
  }
}

/** Doktor/testler için: bilinen modelleri listeler. */
export async function listGeminiModels() {
  const model = await resolveGeminiModel();
  return model;
}

export { config as llmConfig };
