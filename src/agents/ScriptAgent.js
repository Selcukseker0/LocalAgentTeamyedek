import { askLLM } from '../llm/provider.js';
import { log } from '../logger.js';

// Hedef: 45-50 saniyelik Shorts. edge-tts (+20% hız) Türkçe için yaklaşık
// saniyede 2.9 kelime okuyor; TTS_WORDS_PER_SECOND ile kalibre edilebilir.
const WPS = Number(process.env.TTS_WORDS_PER_SECOND || 2.9);
const TARGET_MIN_SEC = 45;
const TARGET_MAX_SEC = 50;

const MIN_WORDS = Math.round(TARGET_MIN_SEC * WPS * 0.97);   // ~127
const MAX_WORDS = Math.round(TARGET_MAX_SEC * WPS * 1.03);   // ~149

// Küçük modeller (qwen2.5:7b) 130 kelimeyi tek yanıtta yazamıyor; metin
// parçalar hâlinde istenir. Hedefe ulaşılamazsa bu sınırın üstü yine kabul edilir.
const ACCEPT_MIN_WORDS = Math.round(MIN_WORDS * 0.86);       // ~109
const PART_SENTENCES = 7;
const WORDS_PER_SENTENCE = '9-11';

const SYSTEM_PROMPT =
  'Sen Türkçe YouTube Shorts senaryosu yazan bir editörsün. ' +
  'Yalnızca istenen JSON nesnesini döndür. Uydurma kelime, başka dil veya açıklama ekleme.';

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\.{3,}/g, '.')
    .replace(/!{2,}/g, '!')
    .replace(/\?{2,}/g, '?')
    .trim();
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
    if (parts.length > 1) out.push(...splitLongSentences(parts, limit));
    else out.push(sentence.trim());
  }
  return out.filter(Boolean);
}

export function estimateSeconds(narration) {
  return countWords(narration) / WPS;
}

/** Modelin "sentences" dizisini tek biçime çevirir. */
export function normalizeItems(raw) {
  if (!Array.isArray(raw?.sentences)) return [];
  return raw.sentences
    .map((item) => (typeof item === 'string' ? { text: item } : item || {}))
    .map((item) => ({
      text: cleanText(item.text),
      scene: cleanText(item.scene),
      label: cleanText(item.label)
    }))
    .filter((item) => item.text)
    .map((item) => ({
      ...item,
      text: /[.!?…]$/.test(item.text) ? item.text : `${item.text}.`
    }));
}

export function itemsToScript(items, meta = {}) {
  const narration = items.map((item) => item.text).join(' ');
  const anyScene = items.some((item) => item.scene);
  const anyLabel = items.some((item) => item.label);

  return {
    title: cleanText(meta.title).replace(/#shorts/gi, '').trim(),
    description: cleanText(meta.description),
    tags: Array.isArray(meta.tags) ? meta.tags.map(cleanText).filter(Boolean) : [],
    narration,
    // Eksik öğeler null olur; sahne planı bunları metinden türetir
    sceneHints: anyScene ? items.map((item) => item.scene || null) : null,
    labels: anyLabel
      ? items.map((item) => (item.label ? item.label.toLocaleUpperCase('tr') : null))
      : null,
    visualQueries: Array.isArray(meta.visualQueries) && meta.visualQueries.length === 4
      ? meta.visualQueries.map(cleanText)
      : []
  };
}

/** Geriye dönük uyumluluk: eski tek-yanıt biçimini (narration/sceneHints) da anlar. */
export function normalizeScript(raw) {
  const script = itemsToScript(normalizeItems(raw), raw || {});

  if (!script.narration && typeof raw?.narration === 'string') {
    script.narration = cleanText(raw.narration);
    if (Array.isArray(raw.sceneHints)) {
      const hints = raw.sceneHints.map(cleanText);
      script.sceneHints = hints.length === splitSentences(script.narration).length ? hints : null;
    }
  }

  return script;
}

export class ScriptAgent {
  async call(prompt, { temperature = 0.7, numPredict = 900, label = 'senaryo' } = {}) {
    const startedAt = Date.now();
    const raw = await askLLM({ system: SYSTEM_PROMPT, prompt, json: true, temperature, numPredict });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log('ScriptAgent', `${label}: ${seconds}s.`);
    return raw || {};
  }

  /** 1. adım: konuyu üç sebebe bölen kısa plan (küçük JSON, model zorlanmaz). */
  async createOutline(topicObj, feedback = '') {
    const prompt = [
      `Konu: "${topicObj.topic}" (Kategori: ${topicObj.category})`,
      feedback ? `Editör notu: ${feedback}` : '',
      '',
      'Bu konuyu 45-50 saniyelik bir Shorts için planla.',
      'Konuyu üç somut sebebe/ana fikre böl. Her sebep tek cümle olsun.',
      'Dil Türkçe, anlaşılır ve gündelik olsun. Emin olmadığın bilgiyi yazma.',
      '',
      'Yalnızca şu JSON biçimini döndür:',
      '{"title":"en fazla 70 karakter",',
      ' "description":"1-2 cümle",',
      ' "tags":["...","...","..."],',
      ' "hook":"izleyiciyi tutan ilk cümle (9-11 kelime)",',
      ' "reasons":["birinci sebep","ikinci sebep","üçüncü sebep"],',
      ' "closing":"kapanış sorusu (9-11 kelime)"}'
    ].filter(Boolean).join('\n');

    const raw = await this.call(prompt, { temperature: 0.7, numPredict: 400, label: 'plan' });

    const reasons = Array.isArray(raw.reasons)
      ? raw.reasons.map(cleanText).filter(Boolean).slice(0, 3)
      : [];

    return {
      title: cleanText(raw.title) || cleanText(topicObj.topic),
      description: cleanText(raw.description),
      tags: Array.isArray(raw.tags) ? raw.tags.map(cleanText).filter(Boolean) : [],
      hook: cleanText(raw.hook),
      reasons,
      closing: cleanText(raw.closing)
    };
  }

  /** 2. adım: planın bir bölümünü cümlelere döker. */
  async writePart(topicObj, outline, part) {
    const reason = (index) => outline.reasons[index] || `konunun ${index + 1}. yönü`;
    const sections = part.reasonIndexes
      .map((index) => `- ${reason(index)} için ${part.perReason} cümle`)
      .join('\n');

    const intro = part.includeIntro
      ? [
        `1) Kanca cümlesi: ${outline.hook || 'konuya şaşırtıcı bir giriş'}`,
        '2) Soru cümlesi: izleyicinin "neden/nasıl" sorusu'
      ]
      : ['1) Kanca ve soru YAZMA; doğrudan sebeplere geç.'];

    const prompt = [
      `Konu: "${topicObj.topic}" (Kategori: ${topicObj.category})`,
      `Video başlığı: ${outline.title}`,
      '',
      'Bu bölüm için Türkçe cümleler yaz:',
      ...intro,
      '3) Sebepler:',
      sections,
      '',
      `Toplam TAM ${part.includeIntro ? PART_SENTENCES : 6} cümle yaz. Eksik cümle bırakma.`,
      `Her cümle ${WORDS_PER_SENTENCE} kelime olsun; 8'den kısa, 12'den uzun olmasın.`,
      'Cümleler birbirini tekrar etmesin, "birincisi/ikincisi" gibi bağlaçlar serbest.',
      'Her cümle için:',
      '- "scene": beyaz tahtaya çizilecek TEK somut nesne (ör. "bal kavanozu", "bakteri", "güneş", "pil", "harita", "fincan").',
      '- "label": tahtaya yazılacak 1-3 kelime (en fazla 18 karakter, ör. "SU YOK", "3000 YIL", "PEKİ NEDEN?").',
      '',
      'Yalnızca şu JSON biçimini döndür:',
      '{"sentences":[{"text":"...","scene":"...","label":"..."}]}'
    ].join('\n');

    const raw = await this.call(prompt, {
      temperature: part.temperature ?? 0.8,
      numPredict: 700,
      label: part.name
    });

    return normalizeItems(raw);
  }

  /** Eksik kalan kelimeler için ek cümle ister. */
  async extendItems(topicObj, outline, items, missingWords) {
    const existing = items.map((item) => item.text).join(' ');
    const prompt = [
      `Konu: "${topicObj.topic}"`,
      `Mevcut metin (${countWords(existing)} kelime): ${existing}`,
      '',
      `Bu metne ${Math.ceil(missingWords / 10)} yeni cümle ekle (her biri 9-11 kelime).`,
      'Mevcut cümleleri tekrarlama; yeni ayrıntı, örnek veya karşılaştırma ekle.',
      'Kapanış sorusu zaten var, onu tekrar yazma.',
      '',
      'Yalnızca JSON: {"sentences":[{"text":"...","scene":"...","label":"..."}]}'
    ].join('\n');

    const raw = await this.call(prompt, { temperature: 0.9, numPredict: 700, label: 'ek cümleler' });
    return normalizeItems(raw);
  }

  async generateScript(topicObj, feedback = '') {
    const outline = await this.createOutline(topicObj, feedback);

    const partA = await this.writePart(topicObj, outline, {
      name: 'bölüm 1',
      includeIntro: true,
      reasonIndexes: [0],
      perReason: 4,
      temperature: 0.8
    });

    const partB = await this.writePart(topicObj, outline, {
      name: 'bölüm 2',
      includeIntro: false,
      reasonIndexes: [1, 2],
      perReason: 2,
      temperature: 0.85
    });

    let items = dedupeItems([...partA, ...partB]);

    const words = () => countWords(items.map((item) => item.text).join(' '));
    log('ScriptAgent', `İlk taslak: ${items.length} cümle, ${words()} kelime.`);

    if (words() < MIN_WORDS) {
      const missing = MIN_WORDS - words();
      log('ScriptAgent', `${missing} kelime eksik; ek cümleler isteniyor.`, 'WARN');
      const extra = await this.extendItems(topicObj, outline, items, missing);
      items = dedupeItems([...items, ...extra]);
    }

    if (outline.closing && !items.some((item) => item.text === cleanText(outline.closing))) {
      items.push({
        text: ensureSentenceEnd(cleanText(outline.closing)),
        scene: 'soru işareti',
        label: 'PEKİ?'
      });
    }

    // Hedefin üstüne çıkarsa sondaki fazla cümleleri at (kapanış korunur)
    let trimCount = 0;
    while (countWords(items.map((item) => item.text).join(' ')) > MAX_WORDS && items.length > 11) {
      items.splice(items.length - 2, 1);
      trimCount += 1;
    }
    if (trimCount) {
      log('ScriptAgent', `Senaryo uzundu; ${trimCount} cümle çıkarıldı.`, 'WARN');
    }

    const wordCount = countWords(items.map((item) => item.text).join(' '));

    if (items.length < 8) {
      throw new Error(
        `Senaryo çok az cümle üretti (${items.length}). ` +
        'Daha büyük bir model deneyin: OLLAMA_MODEL=qwen2.5:14b veya LLM_PROVIDER=gemini.'
      );
    }

    if (wordCount < ACCEPT_MIN_WORDS) {
      throw new Error(
        `Senaryo çok kısa kaldı: ${wordCount} kelime (hedef ${MIN_WORDS}-${MAX_WORDS}). ` +
        'Daha büyük bir model deneyin: OLLAMA_MODEL=qwen2.5:14b veya LLM_PROVIDER=gemini. ' +
        'İsterseniz `--text "metin"` ile senaryoyu elle verebilirsiniz.'
      );
    }

    if (wordCount < MIN_WORDS) {
      log(
        'ScriptAgent',
        `Senaryo hedefin biraz altında (${wordCount}/${MIN_WORDS} kelime, ` +
        `~${estimateSeconds(items.map((item) => item.text).join(' ')).toFixed(0)} sn); devam ediliyor.`,
        'WARN'
      );
    }

    const script = itemsToScript(items, {
      title: outline.title,
      description: outline.description,
      tags: outline.tags
    });

    if (!script.title) script.title = cleanText(topicObj.topic);

    const notTurkish =
      /\b(the|and|with|that|this|from|was|were|they|people|which)\b/i.test(script.narration) &&
      !/[ğüşıöç]/i.test(script.narration);
    if (notTurkish) {
      throw new Error('Model Türkçe yerine İngilizce senaryo döndürdü. OLLAMA_MODEL / LLM_PROVIDER ayarını kontrol edin.');
    }

    log(
      'ScriptAgent',
      `Senaryo hazır: "${script.title}" (${wordCount} kelime, ${items.length} cümle, ` +
      `~${estimateSeconds(script.narration).toFixed(0)} sn).`
    );

    return script;
  }
}

function ensureSentenceEnd(text) {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.text
      .toLocaleLowerCase('tr')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export const SCRIPT_TARGET = {
  wordsPerSecond: WPS,
  minWords: MIN_WORDS,
  maxWords: MAX_WORDS,
  acceptMinWords: ACCEPT_MIN_WORDS,
  targetMinSeconds: TARGET_MIN_SEC,
  targetMaxSeconds: TARGET_MAX_SEC,
  partSentences: PART_SENTENCES
};
