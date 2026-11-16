import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logger.js';
import { similarity } from '../utils/text.js';

// Hedef videodaki stil: beyaz kâğıt üzerine keçeli kalem çizimi, sade dolgu.
// "no text" kritik: görsel modeller Türkçe yazıyı bozuk üretiyor.
const DEFAULT_STYLE =
  'hand-drawn black marker line art, whiteboard doodle style, one single clear scene, ' +
  'centered composition, large subject filling the frame, pure white background, ' +
  'simple flat marker coloring in yellow #F2B705, blue #3F7FBF and orange #E07B39, ' +
  'uniform thick marker outlines, no thin hatching, no gradients, ' +
  'no text, no letters, no numbers, no words, no watermark, no shading, portrait orientation';

const PROVIDERS = ['openai', 'gemini', 'custom', 'pollinations'];

// Vision doğrulaması bu puanın altındaysa prompt düzeltilip yeniden üretilir.
const VISION_PASS_SCORE = Number(process.env.IMAGE_VISION_PASS || 7);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.IMAGE_MAX_ATTEMPTS || 3));
// İki sahnenin prompt'u bu orandan fazla örtüşürse "aynı görsel" sayılır.
const PROMPT_SIMILARITY_LIMIT = 0.8;

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
 * Sahne başına illüstrasyon üretir (Imagen / gpt-image / kendi API'n).
 *
 * Sıra: prompt kur → üret → vision ile puanla → düşükse eksik nesnelerle
 * yeniden üret (en fazla IMAGE_MAX_ATTEMPTS). Hepsi başarısız olursa `null`
 * döner ve o sahne yerleşik çizim kompozisyonuna düşer.
 */
export class ImageAgent {
  constructor() {
    this.provider = (process.env.IMAGE_PROVIDER || '').toLowerCase().trim();
    this.style = process.env.IMAGE_STYLE_PROMPT || DEFAULT_STYLE;
    this.model = process.env.IMAGE_MODEL || '';
    this.size = process.env.IMAGE_SIZE || '';
    this.apiUrl = process.env.IMAGE_API_URL || '';
    this.apiKey = envValue('IMAGE_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY');
    this.lastRun = { scores: [], attempts: 0, retried: 0, duplicates: 0 };
    // Pollinations ücretsiz katmanı oran sınırlı: 429 gelirse bu süre kadar
    // bekleriz ve sonraki isteklerde de temkinli davranırız.
    this.requestDelayMs = Number(process.env.IMAGE_REQUEST_DELAY_MS ?? 1500);
    this.penaltyMs = 0;
  }

  keyFor(provider) {
    if (provider === 'openai') return envValue('OPENAI_API_KEY', 'IMAGE_API_KEY');
    if (provider === 'gemini') return envValue('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'IMAGE_API_KEY');
    // pollinations.ai anahtarsız çalışır (ücretsiz, oran sınırlı)
    if (provider === 'pollinations') return 'free';
    return envValue('IMAGE_API_KEY');
  }

  /** Görsel üretimi kullanılabilir mi? */
  isEnabled() {
    if (!PROVIDERS.includes(this.provider)) return false;
    // Ücretsiz, anahtarsız sağlayıcı: kurulum gerektirmez
    if (this.provider === 'pollinations') return process.env.IMAGE_PROVIDER !== '';
    if (this.provider === 'custom') return Boolean(this.apiUrl && this.keyFor('custom'));
    return Boolean(this.keyFor(this.provider));
  }

  statusLine() {
    if (this.isEnabled()) {
      const extra = this.provider === 'pollinations' ? ' — ücretsiz, anahtarsız, oran sınırlı' : '';
      return `Görsel üretimi açık (IMAGE_PROVIDER=${this.provider}${this.model ? `, model=${this.model}` : ''})${extra}`;
    }
    if (this.provider && PROVIDERS.includes(this.provider)) {
      return `Görsel üretimi kapalı: IMAGE_PROVIDER=${this.provider} ama API anahtarı yok`;
    }
    return 'Görsel üretimi kapalı (IMAGE_PROVIDER ayarlanmamış): yerleşik çizimler kullanılacak';
  }

  /**
   * Görsel prompt'u: stil + cümledeki nesneler + sahne tarifi.
   * @param {{description?:string, narration?:string, objects?:string[]}} job
   * @param {{extraObjects?:string[], avoid?:string[]}} options
   */
  buildPrompt(job = {}, { extraObjects = [], avoid = [] } = {}) {
    const subject = String(job.description || job.narration || '').replace(/\s+/g, ' ').trim();
    const objects = [...new Set([...(job.objects || []), ...extraObjects]
      .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean))];

    const parts = [this.style];
    if (subject) parts.push(`Scene: ${subject}`);
    if (objects.length) parts.push(`Must clearly show: ${objects.join(', ')}`);
    if (avoid.length) {
      parts.push(`Different composition from previous scene, avoid repeating: ${avoid.join(', ')}`);
    }
    return parts.join('. ');
  }

  async requestImage(prompt) {
    if (this.provider === 'openai') return this.openaiImage(prompt);
    if (this.provider === 'gemini') return this.geminiImage(prompt);
    if (this.provider === 'pollinations') return this.pollinationsImage(prompt);
    return this.customImage(prompt);
  }

  /**
   * pollinations.ai — anahtarsız, ücretsiz görsel üretimi (Flux tabanlı).
   * GET /prompt/<metin>?width=..&height=..&model=flux&nologo=true&seed=..
   * Ücretsiz katman oran sınırlı: istekler arasında bekleme yapılır.
   */
  async pollinationsImage(prompt) {
    const [w, h] = String(this.size || '1024x1536').split('x').map((n) => parseInt(n, 10));
    const width = Number.isFinite(w) ? w : 1024;
    const height = Number.isFinite(h) ? h : 1536;
    const attempts = Number(process.env.IMAGE_429_RETRIES || 4);

    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const seed = Math.floor(Math.random() * 1e6);
      const url =
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 1400))}` +
        `?width=${width}&height=${height}&model=${this.model || 'flux'}&nologo=true&seed=${seed}`;

      const res = await fetchWithTimeout(url, { headers: { Accept: 'image/jpeg,image/png' } }, 120_000);

      // Oran sınırı / geçici sunucu hatası: bekle ve aynı isteği tekrarla
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers?.get?.('retry-after') || 0) * 1000;
        const wait = retryAfter || Math.min(60_000, 5000 * 2 ** attempt);
        this.penaltyMs = Math.max(this.penaltyMs, wait);
        log(
          'ImageAgent',
          `Pollinations ${res.status}; ${Math.round(wait / 1000)} sn bekleyip tekrar denenecek ` +
          `(${attempt + 1}/${attempts}). Sonraki isteklerde de bu kadar beklenecek.`,
          'WARN'
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
        lastError = new Error(`Pollinations hatası (${res.status})`);
        continue;
      }

      if (!res.ok) {
        throw new Error(`Pollinations hatası (${res.status}): ${(await res.text()).slice(0, 160)}`);
      }
      const type = res.headers?.get?.('content-type') || '';
      if (!type.startsWith('image/')) {
        throw new Error(`Pollinations görsel döndürmedi (content-type: ${type || 'bilinmiyor'})`);
      }
      // Başarılı istek: cezayı yavaşça azalt
      this.penaltyMs = Math.floor(this.penaltyMs * 0.6);
      return Buffer.from(await res.arrayBuffer());
    }
    throw lastError || new Error('Pollinations görseli üretilemedi');
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
   * Sahneler için görsel üretir. Vision ajanı verilirse kalite kapısı uygulanır.
   * @param {Array<{description?:string,narration?:string,objects?:string[]}>} jobs
   * @param {string} workDir
   * @param {{vision?: import('./VisionAgent.js').VisionAgent}} options
   * @returns {Promise<Array<string|null>>}
   */
  async generateForScenes(jobs, workDir, { vision = null } = {}) {
    if (!this.isEnabled()) return jobs.map(() => null);

    const imageDir = path.join(workDir, 'images');
    await fs.mkdir(imageDir, { recursive: true });

    const results = [];
    const previousPrompts = [];
    const seenHashes = new Set();
    const scores = [];
    let produced = 0;
    let failed = 0;
    let retried = 0;
    let duplicates = 0;

    for (const [index, job] of jobs.entries()) {
      const filePath = path.join(imageDir, `scene_${String(index + 1).padStart(2, '0')}.png`);
      const existing = await fs.stat(filePath).catch(() => null);
      if (existing && existing.size > 2000) {
        results.push(filePath);
        produced += 1;
        previousPrompts.push(this.buildPrompt(job));
        continue;
      }

      const startedAt = Date.now();
      const similar = previousPrompts
        .filter((prompt) => similarity(prompt, this.buildPrompt(job)) >= PROMPT_SIMILARITY_LIMIT)
        .map((prompt) => prompt.slice(-80));
      const avoid = similar.slice(0, 2);

      let best = null;
      let bestScore = -1;
      let extraObjects = [];
      let attempt = 0;

      while (attempt < MAX_ATTEMPTS) {
        const prompt = this.buildPrompt(job, { extraObjects, avoid });
        if (this.provider === 'pollinations') {
          // Ücretsiz katman: istekler arasında kısa bekleme (varsayılan 1.5 sn)
          const delay = Math.max(this.requestDelayMs, this.penaltyMs);
          if (index > 0 && delay > 0) await new Promise((r) => setTimeout(r, delay));
        }
        try {
          const buffer = await this.requestImage(prompt);
          const hash = crypto.createHash('sha1').update(buffer).digest('hex');
          if (seenHashes.has(hash) && attempt + 1 < MAX_ATTEMPTS) {
            duplicates += 1;
            attempt += 1;
            retried += 1;
            extraObjects = [...new Set([...extraObjects, 'a clearly different angle and different background objects'])];
            log('ImageAgent', `Sahne ${index + 1}: görsel öncekiyle aynı çıktı, yeni kompozisyon isteniyor.`, 'WARN');
            continue;
          }
          seenHashes.add(hash);

          let verdict = null;
          if (vision?.isEnabled()) {
            verdict = await vision.check(buffer, job.narration || job.description || '', job.objects || []);
          }
          const score = verdict?.score ?? null;
          if (score !== null) {
            scores[index] = score;
            log('ImageAgent', `Sahne ${index + 1}: görsel puanı ${score}/10${verdict.missing.length ? `, eksik: ${verdict.missing.join(', ')}` : ''}.`);
          }

          if (best === null || (score !== null && score > bestScore)) {
            best = buffer;
            bestScore = score === null ? 0 : score;
          }

          if (score === null || score >= VISION_PASS_SCORE) break;

          // Puan düşük: eksik nesneleri prompt'a ekleyip yeniden dene
          if (verdict?.missing?.length) extraObjects = [...new Set([...extraObjects, ...verdict.missing])];
          else extraObjects = [...new Set([...extraObjects, 'the main subject larger and clearer, fewer details'])];
          attempt += 1;
          retried += 1;
          if (attempt < MAX_ATTEMPTS) {
            log('ImageAgent', `Sahne ${index + 1}: puan ${score}/10 < ${VISION_PASS_SCORE}, yeniden üretiliyor.`, 'WARN');
          }
        } catch (err) {
          attempt += 1;
          if (attempt >= MAX_ATTEMPTS) {
            failed += 1;
            results.push(null);
            log('ImageAgent', `Sahne ${index + 1} görseli üretilemedi: ${err.message}`, 'WARN');
            break;
          }
          log('ImageAgent', `Sahne ${index + 1} denemesi başarısız (${err.message}), tekrar deneniyor.`, 'WARN');
        }
      }

      if (best) {
        await fs.writeFile(filePath, best);
        results.push(filePath);
        produced += 1;
        previousPrompts.push(this.buildPrompt(job));
        log(
          'ImageAgent',
          `Sahne ${index + 1} görseli hazır (${(best.length / 1024).toFixed(0)} KB, ` +
          `${((Date.now() - startedAt) / 1000).toFixed(1)} sn).`
        );
      } else if (results.length <= index) {
        results.push(null);
      }
    }

    this.lastRun = { scores, attempts: jobs.length, retried, duplicates };
    log(
      'ImageAgent',
      `Görseller: ${produced}/${jobs.length} üretildi` +
      (failed ? `, ${failed} başarısız` : '') +
      (retried ? `, ${retried} yeniden deneme` : '')
    );
    return results;
  }
}
