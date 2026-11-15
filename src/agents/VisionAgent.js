import fs from 'node:fs/promises';
import { log } from '../logger.js';

/**
 * Vision doğrulaması: üretilen görsel cümleyi anlatıyor mu?
 *
 * Desteklenen sağlayıcılar:
 *  - gemini  (GEMINI_API_KEY, varsayılan model gemini-2.0-flash)
 *  - openai  (OPENAI_API_KEY, varsayılan model gpt-4o-mini)
 *
 * Anahtar yoksa `isEnabled()` false döner ve doğrulama atlanır; üretim durmaz.
 */

const TIMEOUT_MS = 60000;

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Modelin döndürdüğü serbest metinden JSON'u çıkarır. */
function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  const direct = raw.match(/\{[\s\S]*\}/);
  if (!direct) return null;
  try {
    return JSON.parse(direct[0]);
  } catch {
    return null;
  }
}

export class VisionAgent {
  constructor() {
    const explicit = envValue('VISION_PROVIDER').toLowerCase();
    this.provider = explicit || (envValue('GEMINI_API_KEY', 'GOOGLE_API_KEY') ? 'gemini' : 'openai');
    this.model = envValue('VISION_MODEL')
      || (this.provider === 'openai' ? 'gpt-4o-mini' : 'gemini-2.0-flash');
    this.apiUrl = envValue('VISION_API_URL');
    this.enabled = process.env.VISION_CHECK !== '0';
  }

  key() {
    if (this.provider === 'openai') return envValue('OPENAI_API_KEY');
    if (this.provider === 'custom') return envValue('VISION_API_KEY', 'IMAGE_API_KEY');
    return envValue('GEMINI_API_KEY', 'GOOGLE_API_KEY');
  }

  isEnabled() {
    if (!this.enabled) return false;
    // custom: yerel vision sunucusu (Ollama llava vb.) anahtar istemeyebilir
    if (this.provider === 'custom') return Boolean(this.apiUrl);
    return Boolean(this.key());
  }

  statusLine() {
    if (this.isEnabled()) {
      return `Görsel doğrulama açık (${this.provider}/${this.model})`;
    }
    if (!this.enabled) return 'Görsel doğrulama kapalı (VISION_CHECK=0)';
    return 'Görsel doğrulama kapalı: vision anahtarı yok';
  }

  buildQuestion(narration, objects = []) {
    const list = objects.length ? objects.join(', ') : '(belirtilmedi)';
    return [
      'Bu görsel, bir beyaz tahta çiziminin karesidir.',
      `Anlatılması gereken cümle: "${narration}"`,
      `Cümlede geçen ve görselde olması gereken nesneler: ${list}`,
      '',
      'Görselin bu cümleyi ne kadar iyi anlattığını 1-10 arası puanla.',
      'Eksik veya yanlış nesneleri listele.',
      'Yalnızca JSON döndür: {"score": 7, "missing": ["..."], "note": "kısa açıklama"}'
    ].join('\n');
  }

  async geminiVision(base64, question) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent` +
      `?key=${this.key()}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: question },
            { inline_data: { mime_type: 'image/png', data: base64 } }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 300, responseMimeType: 'application/json' }
      })
    });
    if (!res.ok) throw new Error(`Gemini vision hatası (${res.status}): ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || '')
      .join(' ');
    return parseJsonLoose(text);
  }

  async openaiVision(base64, question) {
    const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.key()}`
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }
          ]
        }]
      })
    });
    if (!res.ok) throw new Error(`OpenAI vision hatası (${res.status}): ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    return parseJsonLoose(data?.choices?.[0]?.message?.content);
  }

  /** Kendi vision API'niz: POST {image, question} -> {score, missing, note}. */
  async customVision(base64, question) {
    const res = await fetchWithTimeout(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.key() ? { Authorization: `Bearer ${this.key()}` } : {})
      },
      body: JSON.stringify({ model: this.model, image: base64, question })
    });
    if (!res.ok) throw new Error(`Vision API hatası (${res.status}): ${(await res.text()).slice(0, 160)}`);
    return parseJsonLoose(await res.text());
  }

  /**
   * @param {string|Buffer} image  dosya yolu veya PNG tamponu
   * @returns {Promise<{score:number, missing:string[], note:string}|null>}
   */
  async check(image, narration, objects = []) {
    if (!this.isEnabled()) return null;
    let base64;
    try {
      const buffer = Buffer.isBuffer(image) ? image : await fs.readFile(image);
      base64 = buffer.toString('base64');
    } catch (err) {
      log('VisionAgent', `Görsel okunamadı: ${err.message}`, 'WARN');
      return null;
    }

    const question = this.buildQuestion(narration, objects);
    try {
      const raw = this.provider === 'openai'
        ? await this.openaiVision(base64, question)
        : (this.provider === 'custom'
          ? await this.customVision(base64, question)
          : await this.geminiVision(base64, question));
      if (!raw) return null;
      const score = Number(raw.score);
      return {
        score: Number.isFinite(score) ? Math.max(1, Math.min(10, score)) : 0,
        missing: Array.isArray(raw.missing)
          ? raw.missing.map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
          : [],
        note: String(raw.note || '').slice(0, 140)
      };
    } catch (err) {
      log('VisionAgent', `Doğrulama yapılamadı: ${err.message}`, 'WARN');
      return null;
    }
  }
}
