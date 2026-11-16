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
import { fingerprintSecret } from '../utils/envCheck.js';
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

/**
 * OpenAI uyumlu ücretsiz/ucuz sağlayıcılar. Hepsi `LLM_API_KEY` + `LLM_MODEL` ile
 * çalışır; URL otomatik gelir. (Groq ve OpenRouter'ın ücretsiz katmanı var,
 * Cerebras ücretsiz kota veriyor, LM Studio/Ollama tamamen yerel.)
 */
const CUSTOM_PRESETS = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  together: 'https://api.together.xyz/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  llamacpp: 'http://127.0.0.1:8080/v1'
};
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

/**
 * OpenAI uyumlu sohbet ucu (Groq, OpenRouter, Cerebras, LM Studio, llama.cpp…).
 * Model `response_format` desteklemiyorsa (400) JSON modu olmadan tekrar denenir.
 */
/**
 * OpenAI uyumlu sağlayıcının taban URL'i (…/v1). `/chat/completions` eklenmiş
 * LLM_API_URL de kabul edilir.
 */
function customBaseUrl(provider) {
  const base = (process.env.LLM_API_URL || CUSTOM_PRESETS[provider] || '').replace(/\/$/, '');
  return base.replace(/\/chat\/completions$/, '');
}

/**
 * Sağlayıcının gerçek model listesi (`GET /models`).
 * Model adları sürekli değişiyor: `llama-3.3-70b-versatile` bir gün 404
 * "does not exist" dönüyor. Tahmin etmek yerine listeyi okuyoruz.
 */
export async function listProviderModels(provider = activeProvider()) {
  const base = customBaseUrl(provider);
  if (!base) throw new Error('LLM_API_URL tanımlı değil');
  const key = process.env.LLM_API_KEY || '';
  const res = await fetch(`${base}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(20_000)
  });
  if (!res.ok) {
    throw new Error(`Model listesi alınamadı (${res.status}) — LLM_MODEL'i elle yazın`);
  }
  const data = await res.json();
  const list = data?.data || data?.models || [];
  return list
    .map((item) => (typeof item === 'string' ? item : item?.id || item?.name))
    .filter(Boolean)
    .sort();
}

// Metin/JSON üretimine uygun olmayanlar (ses, gömme, görsel, moderasyon…)
const MODEL_BLOCK = /whisper|tts|guard|embed|rerank|vision|audio|moderation|distil|clip/i;
// Türkçe + JSON için sırayla tercih: güçlüden hızlıya
const MODEL_HINTS = [
  /gpt-oss-120b/i,
  /llama-3\.3-70b/i,
  /llama-3\.1-70b/i,
  /qwen3?[^/]*32b/i,
  /kimi-k2/i,
  /llama-4[^/]*maverick/i,
  /mixtral/i,
  /llama-3\.1-8b-instant/i,
  /gemma/i
];

/** Model listesinden sohbet için en uygun olanı seçer. */
export function pickModel(models = []) {
  const usable = models.filter((id) => !MODEL_BLOCK.test(id));
  for (const hint of MODEL_HINTS) {
    const hit = usable.find((id) => hint.test(id));
    if (hit) return hit;
  }
  return usable[0] || null;
}

// 404 sonrası bulunan model bu çalıştırma boyunca hatırlanır
const resolvedModels = new Map();

/** Gerçekten kullanılan model (otomatik çözüldüyse o). */
export function currentModel(provider = activeProvider()) {
  return resolvedModels.get(provider) || process.env.LLM_MODEL || '';
}

async function askCustom({ system, prompt, json, temperature, numPredict }) {
  const provider = activeProvider();
  const base = (process.env.LLM_API_URL || CUSTOM_PRESETS[provider] || '').replace(/\/$/, '');
  if (!base) {
    throw new Error(
      `LLM_API_URL tanımlı değil. Örnek: LLM_PROVIDER=groq + LLM_API_KEY=... + LLM_MODEL=llama-3.3-70b-versatile`
    );
  }
  const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  // LLM_MODEL boşsa da çalışır: modeli sağlayıcının listesinden seçeriz.
  let model = process.env.LLM_MODEL || resolvedModels.get(provider) || '';
  if (!model) {
    const models = await listProviderModels(provider).catch((err) => {
      throw new Error(
        `LLM_MODEL tanımlı değil ve model listesi alınamadı (${err.message}). ` +
        `Elle yazın: LLM_MODEL=<sağlayıcının model adı>`
      );
    });
    const pick = pickModel(models);
    if (!pick) throw new Error(`LLM_MODEL tanımlı değil; sağlayıcı ${models.length} model listeledi, uygun olan yok`);
    model = pick;
    resolvedModels.set(provider, model);
    console.warn(`[llm] ${provider}: LLM_MODEL boştu — model listesinden "${model}" seçildi.`);
  }
  const key = process.env.LLM_API_KEY || '';
  const timeoutMs = Number(process.env.LLM_API_TIMEOUT_MS || 60_000);
  const attempts = Number(process.env.LLM_RETRIES || 2);
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: prompt }
  ];

  let lastError = null;
  let modelSwaps = 1; // model adı yanlışsa bir kez otomatik değiştir
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const body = {
      model,
      messages,
      temperature,
      max_tokens: Math.min(8192, Number(numPredict) || 1200),
      ...(json ? { response_format: { type: 'json_object' } } : {})
    };

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      const cause = err?.cause?.code || err?.message || err?.name;
      lastError = new Error(`Bağlantı hatası (${endpoint}): ${cause}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }

    // Bazı sağlayıcılar response_format'ı desteklemez
    if (res.status === 400 && json) {
      try {
        const text = await res.text();
        if (/response_format|json_object/i.test(text)) {
          delete body.response_format;
          res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(key ? { Authorization: `Bearer ${key}` } : {})
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
          });
        } else {
          throw new Error(`API hatası (400): ${text.slice(0, 200)}`);
        }
      } catch (err) {
        lastError = err;
        continue;
      }
    }

    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      // 401 neredeyse her zaman anahtarın kendisi: yanlış/eski anahtar ya da
      // kopyalama kalıntısı. Değeri sızdırmadan parmak izini yaz.
      if (res.status === 401 || res.status === 403) {
        lastError = new Error(
          `API hatası (${res.status}): anahtar reddedildi — LLM_API_KEY: ` +
          `${key ? fingerprintSecret(key) : 'boş'}. ${text}`
        );
        throw lastError;
      }
      // Model adı sağlayıcıda yok (Groq: "does not exist or you do not have access")
      if (res.status === 404 && modelSwaps > 0) {
        modelSwaps -= 1;
        const models = await listProviderModels(provider).catch(() => []);
        const pick = pickModel(models);
        if (pick && pick !== model) {
          console.warn(
            `[llm] ${provider}: "${model}" bulunamadı (404) — canlı listeden "${pick}" seçildi` +
            ` (${models.length} model). .env'deki LLM_MODEL satırını da güncelleyin.`
          );
          model = pick;
          resolvedModels.set(provider, model);
          attempt -= 1;
          continue;
        }
        lastError = new Error(
          `API hatası (404): "${model}" sağlayıcıda yok.` +
          (models.length ? ` Mevcut modeller: ${models.slice(0, 12).join(', ')}` : ' Model listesi alınamadı.')
        );
        lastError.models = models;
        throw lastError;
      }
      lastError = new Error(`API hatası (${res.status}): ${text}`);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers?.get?.('retry-after') || 0) * 1000;
        await new Promise((r) => setTimeout(r, retryAfter || Math.min(30_000, 2000 * 2 ** attempt)));
        continue;
      }
      throw lastError;
    }

    const data = await res.json();
    const content = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!content) {
      lastError = new Error('Boş yanıt döndü');
      continue;
    }
    return json ? parseJsonContent(content) : content;
  }
  throw lastError || new Error('Model çağrısı başarısız');
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

export function isCustomProvider(provider = activeProvider()) {
  return provider === 'custom' || Boolean(CUSTOM_PRESETS[provider]);
}

export { CUSTOM_PRESETS };

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
  if (provider === 'custom' || CUSTOM_PRESETS[provider]) {
    const base = process.env.LLM_API_URL || CUSTOM_PRESETS[provider];
    if (!base) return { usable: false, reason: 'LLM_API_URL yok' };
    if (!process.env.LLM_MODEL) return { usable: false, reason: 'LLM_MODEL yok' };
    if (breakerOpen(provider)) return { usable: false, reason: 'üst üste bağlantı hatası' };
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
    const result = provider === 'gemini'
      ? await askGemini(options)
      : (provider === 'anthropic' ? await askAnthropic(options) : await askCustom(options));
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
