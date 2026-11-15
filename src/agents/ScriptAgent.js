import { askOllama } from '../llm/ollamaClient.js';
import { log } from '../logger.js';

// Hedef: 45-50 saniyelik Shorts. edge-tts (+20% hız) Türkçe için yaklaşık
// saniyede 2.9 kelime okuyor; TTS_WORDS_PER_SECOND ile kalibre edilebilir.
const WPS = Number(process.env.TTS_WORDS_PER_SECOND || 2.9);
const TARGET_MIN_SEC = 45;
const TARGET_MAX_SEC = 50;
const HARD_MIN_SEC = 40;
const HARD_MAX_SEC = 56;

const MIN_WORDS = Math.round(TARGET_MIN_SEC * WPS * 0.97);   // ~127
const MAX_WORDS = Math.round(TARGET_MAX_SEC * WPS * 1.03);   // ~149
const MIN_SENTENCES = 10;
const MAX_SENTENCES = 15;

function cleanScript(script) {
  if (typeof script.title === 'string') {
    script.title = script.title.replace(/#shorts/gi, '').trim();
  }

  if (typeof script.narration === 'string') {
    script.narration = script.narration
      .replace(/\s+/g, ' ')
      .replace(/\.{3,}/g, '.')
      .replace(/\!{2,}/g, '!')
      .replace(/\?{2,}/g, '?')
      .trim();
  }

  if (Array.isArray(script.sceneHints)) {
    script.sceneHints = script.sceneHints
      .map((hint) => String(hint || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  return script;
}

export function countWords(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

export function splitSentences(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .filter(Boolean);
}

/** 14 kelimeden uzun cümleleri virgülden bölerek altyazıyı okunur tutar. */
export function splitLongSentences(sentences, limit = 14) {
  const out = [];
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length <= limit) {
      out.push(sentence.trim());
      continue;
    }
    const parts = sentence.split(/(?<=,)\s+/);
    if (parts.length > 1) {
      out.push(...splitLongSentences(parts, limit));
    } else {
      out.push(sentence.trim());
    }
  }
  return out.filter(Boolean);
}

export function estimateSeconds(narration) {
  return countWords(narration) / WPS;
}

function durationOk(narration) {
  const seconds = estimateSeconds(narration);
  return seconds >= HARD_MIN_SEC && seconds <= HARD_MAX_SEC;
}

function buildPrompt(topicObj, feedback = '') {
  return `Bir Türkçe YouTube Shorts senaryosu hazırla. Video 45-50 saniye sürecek.

Konu: "${topicObj.topic}" (Kategori: ${topicObj.category})
${feedback ? `Önceki inceleme notu: ${feedback}` : ''}

Kurallar:
- narration yalnızca doğal, gündelik Türkçe olsun; ${MIN_WORDS}-${MAX_WORDS} kelime, ${MIN_SENTENCES}-${MAX_SENTENCES} kısa cümle yaz.
- Her cümle en fazla 12 kelime olsun.
- Yapı: ilk cümle güçlü bir kanca olsun. Sonra 3 somut bilgi/madde anlat (her biri 2-3 cümle). Son cümle kısa bir soru olsun.
- Emin olmadığın bilgiyi, özel terimi, sayıyı veya iddiayı uydurma; emin değilsen çıkar.
- Anlamsız kelime, başka dil veya sahne notu kullanma.
- sceneHints: her cümle için, o cümlede beyaz tahtaya çizilecek somut bir nesne/kavram yaz. Cümle sayısıyla birebir aynı sayıda olmalı. Örnekler: "vazo", "süt kutusu", "bakteri", "saat", "güneş", "telefon", "grafik", "kalkan", "alev", "bulut", "alışveriş çantası", "soru işareti", "kalp", "para", "ev", "kitap", "arı", "fabrika".
- Başlığa #shorts ekleme.

Yalnızca şu JSON biçimini döndür:
{"title":"...", "description":"...", "tags":["..."], "narration":"...", "sceneHints":["...","..."], "visualQueries":["...","...","...","..."]}`;
}

export class ScriptAgent {
  async requestScript(prompt, system, temperature = 0.2) {
    return cleanScript(await askOllama({ system, prompt, json: true, temperature }));
  }

  async generateScript(topicObj, feedback = '') {
    const system =
      'Sen Türkçe yazan, doğal ve açık anlatımlı bir Shorts senaristisin. ' +
      'Uydurma kelime kullanma; yalnızca istenen JSON nesnesini döndür.';

    let script = await this.requestScript(buildPrompt(topicObj, feedback), system);
    let wordCount = countWords(script.narration);

    if (wordCount < MIN_WORDS || wordCount > MAX_WORDS || !durationOk(script.narration)) {
      const seconds = estimateSeconds(script.narration).toFixed(1);
      script = await this.requestScript(
        `Önceki JSON senaryo hedefe uymadı: ${wordCount} kelime, tahmini ${seconds} saniye.
Hedef: ${TARGET_MIN_SEC}-${TARGET_MAX_SEC} saniye, yani ${MIN_WORDS}-${MAX_WORDS} kelime ve ${MIN_SENTENCES}-${MAX_SENTENCES} cümle.
Önceki JSON: ${JSON.stringify({ ...script, sceneHints: undefined })}

Senaryoyu baştan yaz; eksik metne devam etme. Aynı alanları koru, sceneHints cümle sayısıyla eşit olsun.
Yalnızca doğru JSON nesnesini döndür.`,
        system,
        0.1
      );
      wordCount = countWords(script.narration);
    }

    if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
      throw new Error(
        `Ollama senaryosu ${MIN_WORDS}-${MAX_WORDS} kelime olmalı; ${wordCount} kelime üretildi.`
      );
    }

    const scriptText = `${script.title || ''} ${script.narration || ''}`;
    if (!/^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\s]*$/u.test(scriptText)) {
      throw new Error('Ollama senaryosu Türkçe dışı karakterler içeriyor; senaryo reddedildi.');
    }

    const sentences = splitSentences(script.narration);
    if (sentences.length < 6) {
      throw new Error(`Senaryo çok az cümle içeriyor (${sentences.length}); en az 6 bekleniyordu.`);
    }
    if (sentences.length < MIN_SENTENCES) {
      log('ScriptAgent', `Cümle sayısı hedefin altında: ${sentences.length} (hedef ${MIN_SENTENCES}+)`, 'WARN');
    }

    // sceneHints cümle sayısıyla eşleşmiyorsa sahne planı otomatik yapılır
    if (!Array.isArray(script.sceneHints) || script.sceneHints.length !== sentences.length) {
      script.sceneHints = null;
    }

    if (!Array.isArray(script.visualQueries) || script.visualQueries.length !== 4) {
      script.visualQueries = [];
    }

    log(
      'ScriptAgent',
      `Senaryo: "${script.title}" (${wordCount} kelime, ${sentences.length} cümle, ` +
      `~${estimateSeconds(script.narration).toFixed(0)} sn) [Ollama]`
    );
    return script;
  }
}

export const SCRIPT_TARGET = {
  wordsPerSecond: WPS,
  minWords: MIN_WORDS,
  maxWords: MAX_WORDS,
  targetMinSeconds: TARGET_MIN_SEC,
  targetMaxSeconds: TARGET_MAX_SEC,
  minSentences: MIN_SENTENCES,
  maxSentences: MAX_SENTENCES
};
