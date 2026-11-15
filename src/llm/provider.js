import { config } from '../config.js';
import { askOllama } from './ollamaClient.js';

/**
 * Tek bir "LLM sağlayıcı" arayüzü.
 * LLM_PROVIDER=ollama | gemini | anthropic
 *
 * Hepsinde imza aynı: { system, prompt, json, temperature, numPredict } -> nesne veya metin.
 * API anahtarı yoksa ya da istek başarısız olursa Ollama'ya düşer (akış durmasın).
 */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
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

async function askGemini({ system, prompt, json, temperature, numPredict }) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY tanımlı değil');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system || '' }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: numPredict || 1200,
          ...(json ? { responseMimeType: 'application/json' } : {})
        }
      })
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini API hatası (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  const content = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || '')
    .join('')
    .trim();

  if (!content) throw new Error('Gemini boş yanıt döndürdü');
  return json ? parseJsonContent(content) : content;
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
      console.warn(`[llm] ${provider} başarısız (${err.message}); Ollama'ya geçiliyor.`);
    }
  }

  return askOllama(options);
}

export { config as llmConfig };
