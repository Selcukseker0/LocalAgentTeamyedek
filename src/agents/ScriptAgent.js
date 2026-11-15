import { askLLM } from '../llm/provider.js';
import { log } from '../logger.js';

// Hedef: 45-50 saniyelik Shorts. edge-tts (+20% hız) Türkçe için yaklaşık
// saniyede 2.9 kelime okuyor; TTS_WORDS_PER_SECOND ile kalibre edilebilir.
const WPS = Number(process.env.TTS_WORDS_PER_SECOND || 2.9);
const TARGET_MIN_SEC = 45;
const TARGET_MAX_SEC = 50;

const MIN_WORDS = Math.round(TARGET_MIN_SEC * WPS * 0.97);   // ~127
const MAX_WORDS = Math.round(TARGET_MAX_SEC * WPS * 1.03);   // ~149
// Kesin hedefe ulaşılamazsa bu sınırın üstündeki senaryo yine kabul edilir
// (kullanıcı boş çıktı yerine kısa bir video görsün).
const ACCEPT_MIN_WORDS = Math.round(MIN_WORDS * 0.86);       // ~109
const MIN_SENTENCES = 12;
const MAX_SENTENCES = 16;
const MIN_ACCEPT_SENTENCES = 9;
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

/**
 * Ollama yanıtını {title, description, tags, narration, sceneHints} biçimine çevirir.
 * Model hem `sentences` dizisi (tercih edilen) hem de düz `narration` döndürebilir.
 */
export function normalizeScript(raw) {
  const script = {
    title: cleanText(raw.title).replace(/#shorts/gi, '').trim(),
    description: cleanText(raw.description),
    tags: Array.isArray(raw.tags) ? raw.tags.map(cleanText).filter(Boolean) : [],
    narration: '',
    sceneHints: null,
    labels: null,
    visualQueries: []
  };

  if (Array.isArray(raw.sentences) && raw.sentences.length) {
    const items = raw.sentences
      .map((item) => (typeof item === 'string' ? { text: item } : item || {}))
      .map((item) => ({
        text: cleanText(item.text),
        scene: cleanText(item.scene),
        label: cleanText(item.label)
      }))
      .filter((item) => item.text)
      // Cümle sonu noktalama yoksa ekle: birleştirince sınırlar kaybolmasın
      .map((item) => ({
        ...item,
        text: /[.!?…]$/.test(item.text) ? item.text : `${item.text}.`
      }));

    script.narration = items.map((item) => item.text).join(' ');
    script.labels = items.map((item) => (item.label ? item.label.toLocaleUpperCase('tr') : null));

    // Her öğe birden fazla cümleye bölünürse sahne ipucu cümle sayısıyla eşlenir
    if (items.length && items.every((item) => item.scene)) {
      script.sceneHints = items.flatMap((item) =>
        splitSentences(item.text).map(() => item.scene)
      );
    }
  } else if (typeof raw.narration === 'string') {
    script.narration = cleanText(raw.narration);
    if (Array.isArray(raw.sceneHints)) {
      const hints = raw.sceneHints.map(cleanText);
      script.sceneHints = hints.length === splitSentences(script.narration).length ? hints : null;
    }
  }

  if (Array.isArray(raw.visualQueries) && raw.visualQueries.length === 4) {
    script.visualQueries = raw.visualQueries.map(cleanText);
  }

  return script;
}

function buildPrompt(topicObj, { feedback = '', previous = null, strict = false } = {}) {
  const lines = [
    'Türkçe bir YouTube Shorts senaryosu hazırla. Video 45-50 saniye sürecek.',
    '',
    `Konu: "${topicObj.topic}" (Kategori: ${topicObj.category})`,
    ''
  ];

  if (feedback) {
    lines.push(`Önceki inceleme notu: ${feedback}`, '');
  }
  if (previous) {
    lines.push(
      `Önceki denemede ${countWords(previous.narration)} kelime çıktı; bu çok kısa.`,
      'Senaryoyu genişlet: aynı konuya 5-7 yeni cümle ekle, mevcut cümleleri de koru.',
      `Önceki metin: ${previous.narration}`,
      ''
    );
  }

  lines.push(
    'KURGU (kısa video senaryosu gibi, ama sahne yönetmeni için):',
    '- Cümle 1-2: KANCA. Şaşırtıcı bir sayı/durum + merak sorusu. ("... hâlâ yenebilir durumdaydı.")',
    '- Cümle 3: SORU. İzleyicinin aklındaki "nasıl oluyor?" sorusunu sor.',
    '- Cümle 4-8: SEBEP 1 ve SEBEP 2. Her sebep 2-3 cümle, somut ve tek tek anlatılır.',
    '- Cümle 9-11: ek ayrıntı ya da üçüncü sebep (varsa).',
    '- Son cümle: KAPANIŞ SORUSU ("Peki sence ...?").',
    'Kurallar:',
    `1) "sentences" ${MIN_SENTENCES}-${MAX_SENTENCES} öğe olsun.`,
    `2) Her cümle ${WORDS_PER_SENTENCE} kelime (9'dan kısa, 12'den uzun olmasın).`,
    `3) Toplam ${MIN_WORDS}-${MAX_WORDS} kelime olacak; ${MIN_SENTENCES} cümleden az yazma.`,
    '4) Cümleler konuşma diliyle yazılsın; "birincisi", "ikincisi", "peki" gibi bağlaçlar serbest.',
    '5) Emin olmadığın bilgiyi, sayıyı veya iddiayı yazma.',
    '6) Her cümle için "scene": beyaz tahtaya çizilecek TEK somut nesne/durum.',
    '   Örnekler: "bal kavanozu", "süt kutusu", "kahve fincanı", "güneş", "gezegen",',
    '   "bakteri", "saat", "para", "grafik", "kalkan", "alev", "bulut", "arı",',
    '   "kitap", "ev", "telefon", "soru işareti", "kalp", "pil", "roket", "harita".',
    '7) Her cümle için "label": tahtaya yazılacak 1-3 kelimelik etiket (en fazla 18 karakter).',
    '   Örnekler: "3000 YIL", "SU YOK", "ANTİSEPTİK", "2 SEBEP", "PEKİ NEDEN?".',
    '   Etiket cümlenin ana fikrini versin; her cümlede farklı olsun.',
    '8) Başlığa #shorts ekleme; title en fazla 70 karakter olsun.',
    ''
  );

  if (strict) {
    lines.push(
      `SADECE ${MIN_SENTENCES + 2} cümle yaz ve her cümleyi tam 10 kelimeye tamamla. ` +
      'Kısa yazmak yasak; eksik cümle bırakma.',
      ''
    );
  }

  lines.push(
    'Yalnızca şu JSON biçimini döndür:',
    '{"title":"...","description":"...","tags":["...","..."],' +
      '"sentences":[{"text":"...","scene":"...","label":"..."},' +
      '{"text":"...","scene":"...","label":"..."}],' +
      '"visualQueries":["...","...","...","..."]}'
  );

  return lines.join('\n');
}

export class ScriptAgent {
  async requestScript(prompt, temperature = 0.8, numPredict = 900) {
    const startedAt = Date.now();
    const raw = await askLLM({
      system: SYSTEM_PROMPT,
      prompt,
      json: true,
      temperature,
      numPredict
    });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const script = normalizeScript(raw || {});
    log('ScriptAgent', `Ollama yanıtı ${seconds}s (${countWords(script.narration)} kelime).`);
    return script;
  }

  async generateScript(topicObj, feedback = '') {
    let script = null;
    let wordCount = 0;
    let attempts = 0;

    // 1) normal istek
    script = await this.requestScript(buildPrompt(topicObj, { feedback }));
    attempts += 1;
    wordCount = countWords(script.narration);

    // 2) kısa çıktı: mevcut metni genişlet (tek ek deneme: hız için)
    if (wordCount < MIN_WORDS) {
      log(
        'ScriptAgent',
        `Senaryo kısa (${wordCount} kelime); genişletme isteği gönderiliyor.`,
        'WARN'
      );
      script = await this.requestScript(
        buildPrompt(topicObj, { feedback, previous: script, strict: true }),
        0.9,
        1100
      );
      attempts += 1;
      wordCount = countWords(script.narration);
    }

    if (!script.narration) {
      throw new Error('Ollama boş senaryo döndürdü. Tekrar deneyin.');
    }

    const notTurkish =
      /\b(the|and|with|that|this|from|was|were|they|people|which)\b/i.test(script.narration) &&
      !/[ğüşıöç]/i.test(script.narration);
    if (notTurkish) {
      throw new Error('Ollama Türkçe yerine İngilizce senaryo döndürdü. OLLAMA_MODEL değerini kontrol edin.');
    }

    let sentences = splitSentences(script.narration);

    if (wordCount > MAX_WORDS + 20) {
      // Uzun çıktıyı kesmek yerine kısaltma isteği gönder
      log('ScriptAgent', `Senaryo uzun (${wordCount} kelime); kısaltılıyor.`, 'WARN');
      script = await this.requestScript(
        `${buildPrompt(topicObj, { feedback })}\n\nÖnceki metin ${wordCount} kelimeydi, çok uzun. ` +
        `Aynı konuyu ${MIN_WORDS}-${MAX_WORDS} kelimeye indirerek yeniden yaz.`,
        0.4,
        1400
      );
      wordCount = countWords(script.narration);
      sentences = splitSentences(script.narration);
      attempts += 1;
    }

    if (sentences.length < MIN_ACCEPT_SENTENCES) {
      throw new Error(
        `Senaryo çok az cümle içeriyor (${sentences.length}). ` +
        `${MIN_SENTENCES}+ cümle gerekiyor; tekrar deneyin.`
      );
    }

    if (wordCount < ACCEPT_MIN_WORDS) {
      throw new Error(
        `Ollama senaryosu çok kısa kaldı: ${wordCount} kelime ` +
        `(hedef ${MIN_WORDS}-${MAX_WORDS}, ${attempts} deneme). ` +
        'Daha büyük bir model deneyin: OLLAMA_MODEL=qwen2.5:7b veya 14b.'
      );
    }

    if (wordCount < MIN_WORDS) {
      log(
        'ScriptAgent',
        `Senaryo hedefin biraz altında (${wordCount}/${MIN_WORDS} kelime, ` +
        `~${estimateSeconds(script.narration).toFixed(0)} sn); devam ediliyor.`,
        'WARN'
      );
    }

    // sceneHints cümle sayısıyla eşleşmiyorsa sahne planı otomatik yapılır
    if (!Array.isArray(script.sceneHints) || script.sceneHints.length !== sentences.length) {
      script.sceneHints = null;
    }
    if (!Array.isArray(script.labels) ||
        script.labels.length !== sentences.length ||
        script.labels.some((label) => !label)) {
      script.labels = null;
    }

    if (!script.title) script.title = cleanText(topicObj.topic);
    if (!Array.isArray(script.visualQueries) || script.visualQueries.length !== 4) {
      script.visualQueries = [];
    }
    log(
      'ScriptAgent',
      `Senaryo: "${script.title}" (${wordCount} kelime, ${sentences.length} cümle, ` +
      `~${estimateSeconds(script.narration).toFixed(0)} sn, ${attempts} deneme) [Ollama]`
    );
    return script;
  }
}

export const SCRIPT_TARGET = {
  wordsPerSecond: WPS,
  minWords: MIN_WORDS,
  maxWords: MAX_WORDS,
  acceptMinWords: ACCEPT_MIN_WORDS,
  targetMinSeconds: TARGET_MIN_SEC,
  targetMaxSeconds: TARGET_MAX_SEC,
  minSentences: MIN_SENTENCES,
  maxSentences: MAX_SENTENCES
};
