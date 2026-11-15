import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logger.js';

// Hedef videodaki stil: beyaz kâğıt üzerine keçeli kalem çizimi, sade dolgu.
// "no text" kritik: görsel modeller Türkçe yazıyı bozuk üretiyor.
const DEFAULT_STYLE =
  'hand-drawn black marker line art, whiteboard doodle style, detailed single clear scene, ' +
  'centered composition, pure white background, simple flat marker coloring ' +
  '(yellow, blue, orange), thick clean outlines, expressive simple cartoon shapes, ' +
  'no text, no letters, no numbers, no words, no watermark, no shading, portrait orientation';

const PROVIDERS = ['openai', 'gemini', 'custom'];

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

function words(text) {
  return String(text || '')
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function similarity(a, b) {
  const setA = new Set(words(a));
  const setB = new Set(words(b));
  if (!setA.size || !setB.size) return 0;
  let common = 0;
  for (const token of setA) if (setB.has(token)) common += 1;
  return common / new Set([...setA, ...setB]).size;
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
