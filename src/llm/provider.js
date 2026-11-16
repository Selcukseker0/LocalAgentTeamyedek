import { config } from '../config.js';
import { askOllama } from './ollamaClient.js';

/**
 * Tek bir "LLM sağlayıcı" arayüzü.
 * LLM_PROVIDER=ollama | gemini | anthropic
 *
 * Hepsinde imza aynı: { system, prompt, json, temperature, numPredict } -> nesne veya metin.
 * API anahtarı yoksa ya da istek başarısız olursa Ollama'ya düşer (akış durmasın).
 */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

function parseJsonContent(content) {
  const text = String(content || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Model geçerli JSON döndürmedi: ${text.slice(0, 200)}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GEMINI_RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 120000);
// Gemini 3.x "düşünen" bir modeldir: düşünme token'ları da maxOutputTokens'a sayılır.
// Limit düşük kalırsa cevap JSON'un ortasında kesilir. Bu yüzden alt sınır konur.
const GEMINI_MIN_OUTPUT_TOKENS = Number(process.env.GEMINI_MIN_OUTPUT_TOKENS || 8192);

async function askGemini({ system, prompt, json, temperature, numPredict }) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY tanımlı değil');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system || '' }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: Math.max(numPredict || 1200, GEMINI_MIN_OUTPUT_TOKENS),
      ...(json ? { responseMimeType: 'application/json' } : {})
    }
  });

  let lastErr = new Error('Gemini yanıt vermedi');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        // Anahtar URL yerine başlıkta gider (loglara/hata mesajlarına sızmasın)
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body,
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
      });
    } catch (err) {
      // "fetch failed" tek başına bilgi vermez; gerçek neden err.cause içindedir
      const cause = err.cause?.code || err.cause?.message || err.name || err.message;
      lastErr = new Error(`Gemini bağlantı hatası: ${cause}`);
      await sleep(3000 * 2 ** attempt);
      continue;
    }

    if (!res.ok) {
      lastErr = new Error(`Gemini API hatası (${res.status}): ${(await res.text()).slice(0, 300)}`);
      if (!GEMINI_RETRY_STATUS.has(res.status)) throw lastErr; // 404/400/403: tekrar denemek boşuna
      await sleep(3000 * 2 ** attempt); // 3s, 6s, 12s, 24s
      continue;
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const finish = candidate?.finishReason;
    const content = (candidate?.content?.parts || [])
      .filter((part) => !part.thought)
      .map((part) => part.text || '')
      .join('')
      .trim();

    if (finish && finish !== 'STOP') console.warn(`[llm] Gemini finishReason=${finish}`);
    if (!content) {
      lastErr = new Error(`Gemini boş yanıt döndürdü${finish ? ` (finishReason=${finish})` : ''}`);
      continue;
    }

    try {
      return json ? parseJsonContent(content) : content;
    } catch (err) {
      lastErr = err; // yarım/bozuk JSON: yeniden sor
    }
  }
  throw lastErr;
}

/** doctor için: küçük bir istekle Gemini'ye ulaşılabiliyor mu? */
export async function pingGemini() {
  const startedAt = Date.now();
  const text = await askGemini({
    system: 'Kısa cevap ver.',
    prompt: 'Sadece "tamam" yaz.',
    json: false,
    temperature: 0,
    numPredict: 64
  });
  return { ms: Date.now() - startedAt, model: GEMINI_MODEL, text: text.slice(0, 40) };
}

async function askAnthropic({ system, prompt, json, temperature, numPredict }) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY tanımlı değil');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: numPredict || 1200,
      temperature,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });

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

export async function askLLM(options) {
  const provider = activeProvider();

  if (provider === 'gemini' || provider === 'anthropic') {
    try {
      const result = provider === 'gemini' ? await askGemini(options) : await askAnthropic(options);
      return result;
    } catch (err) {
      // LLM_NO_FALLBACK=1: yavaş yerel modele düşmek yerine hemen dur ve nedenini göster
      if (process.env.LLM_NO_FALLBACK === '1') {
        throw new Error(`${provider} başarısız ve LLM_NO_FALLBACK=1: ${err.message}`);
      }
      console.warn(`[llm] ${provider} başarısız (${err.message}); Ollama'ya geçiliyor.`);
    }
  }

  return askOllama(options);
}

export { config as llmConfig };
