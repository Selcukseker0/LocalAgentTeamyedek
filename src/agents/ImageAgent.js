import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logger.js';

// Hedef videodaki stil: beyaz kâğıt üzerine keçeli kalem çizimi, sade dolgu.
const DEFAULT_STYLE =
  'hand-drawn black marker line art, whiteboard doodle style, detailed single clear scene, ' +
  'centered composition, pure white background, simple flat marker coloring ' +
  '(yellow, blue, orange), thick clean outlines, no text, no letters, no numbers, ' +
  'no watermark, no shading, portrait orientation';

const PROVIDERS = ['openai', 'gemini', 'custom'];

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sahne başına illüstrasyon üretir (Flux / Imagen / gpt-image).
 *
 * Anahtar yoksa veya istek başarısız olursa `null` döner; video üretimi
 * durmaz, o sahne için yerleşik çizim kompozisyonuna düşülür.
 */
export class ImageAgent {
  constructor() {
    this.provider = (process.env.IMAGE_PROVIDER || '').toLowerCase().trim();
    this.style = process.env.IMAGE_STYLE_PROMPT || DEFAULT_STYLE;
    this.model = process.env.IMAGE_MODEL || '';
    this.size = process.env.IMAGE_SIZE || '';
    this.apiUrl = process.env.IMAGE_API_URL || '';
    this.apiKey = envValue('IMAGE_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY');
  }

  keyFor(provider) {
    if (provider === 'openai') return envValue('OPENAI_API_KEY', 'IMAGE_API_KEY');
    if (provider === 'gemini') return envValue('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'IMAGE_API_KEY');
    return envValue('IMAGE_API_KEY');
  }

  /** Görsel üretimi kullanılabilir mi? */
  isEnabled() {
    if (!PROVIDERS.includes(this.provider)) return false;
    if (this.provider === 'custom') return Boolean(this.apiUrl && this.keyFor('custom'));
    return Boolean(this.keyFor(this.provider));
  }

  statusLine() {
    if (this.isEnabled()) {
      return `Görsel üretimi açık (IMAGE_PROVIDER=${this.provider}${this.model ? `, model=${this.model}` : ''})`;
    }
    if (this.provider && PROVIDERS.includes(this.provider)) {
      return `Görsel üretimi kapalı: IMAGE_PROVIDER=${this.provider} ama API anahtarı yok`;
    }
    return 'Görsel üretimi kapalı (IMAGE_PROVIDER ayarlanmamış): yerleşik çizimler kullanılacak';
  }

  buildPrompt(description, narration = '') {
    const subject = (description || narration || '').replace(/\s+/g, ' ').trim();
    return `${this.style}. Scene: ${subject}`;
  }

  async requestImage(prompt) {
    if (this.provider === 'openai') return this.openaiImage(prompt);
    if (this.provider === 'gemini') return this.geminiImage(prompt);
    return this.customImage(prompt);
  }

  async openaiImage(prompt) {
    const res = await fetchWithTimeout('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.keyFor('openai')}`
      },
      body: JSON.stringify({
        model: this.model || 'gpt-image-1',
        prompt,
        n: 1,
        size: this.size || '1024x1536'
      })
    });
    if (!res.ok) throw new Error(`OpenAI görsel hatası (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI yanıtında görsel yok');
    return Buffer.from(b64, 'base64');
  }

  async geminiImage(prompt) {
    const model = this.model || 'imagen-3.0-generate-002';
    const key = this.keyFor('gemini');
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio: this.size || '3:4' }
        })
      }
    );
    if (!res.ok) throw new Error(`Gemini görsel hatası (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const b64 = data?.predictions?.[0]?.bytesBase64Encoded
      || data?.predictions?.[0]?.image?.bytesBase64Encoded;
    if (!b64) throw new Error('Gemini yanıtında görsel yok');
    return Buffer.from(b64, 'base64');
  }

  /** Kendi ucuz görsel API'niz: POST {prompt} -> {image|b64|url}. */
  async customImage(prompt) {
    const res = await fetchWithTimeout(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.keyFor('custom')}`
      },
      body: JSON.stringify({ prompt, size: this.size || '1024x1536' })
    });
    if (!res.ok) throw new Error(`Görsel API hatası (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const b64 = data?.image || data?.b64 || data?.data?.[0]?.b64_json;
    if (b64) return Buffer.from(b64, 'base64');
    const url = data?.url || data?.data?.[0]?.url;
    if (url) {
      const image = await fetchWithTimeout(url);
      if (!image.ok) throw new Error(`Görsel indirilemedi (${image.status})`);
      return Buffer.from(await image.arrayBuffer());
    }
    throw new Error('Görsel API yanıtı anlaşılmadı');
  }

  /**
   * Sahneler için görsel üretir.
   * @param {Array<{description:string,narration:string}>} jobs
   * @param {string} workDir
   * @returns {Promise<Array<string|null>>} her sahne için dosya yolu veya null
   */
  async generateForScenes(jobs, workDir) {
    if (!this.isEnabled()) return jobs.map(() => null);

    const imageDir = path.join(workDir, 'images');
    await fs.mkdir(imageDir, { recursive: true });

    const results = [];
    let produced = 0;
    let failed = 0;

    for (const [index, job] of jobs.entries()) {
      const filePath = path.join(imageDir, `scene_${String(index + 1).padStart(2, '0')}.png`);
      const existing = await fs.stat(filePath).catch(() => null);
      if (existing && existing.size > 2000) {
        results.push(filePath);
        produced += 1;
        continue;
      }

      const prompt = this.buildPrompt(job.description, job.narration);
      const startedAt = Date.now();
      try {
        const buffer = await this.requestImage(prompt);
        await fs.writeFile(filePath, buffer);
        results.push(filePath);
        produced += 1;
        log(
          'ImageAgent',
          `Sahne ${index + 1} görseli hazır (${(buffer.length / 1024).toFixed(0)} KB, ` +
          `${((Date.now() - startedAt) / 1000).toFixed(1)} sn).`
        );
      } catch (err) {
        failed += 1;
        results.push(null);
        log('ImageAgent', `Sahne ${index + 1} görseli üretilemedi: ${err.message}`, 'WARN');
      }
    }

    log(
      'ImageAgent',
      `Görseller: ${produced}/${jobs.length} üretildi` + (failed ? `, ${failed} başarısız` : '')
    );
    return results;
  }
}
