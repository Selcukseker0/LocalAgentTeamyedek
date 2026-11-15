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

// Tek kelimelik yarım cümleler / etiket artıkları altyazıya düşmesin
const MIN_ITEM_WORDS = 6;
const LABEL_MAX_CHARS = 18;
const MAX_EXTEND_ATTEMPTS = 2;

const SYSTEM_PROMPT =
  'Sen Türkçe YouTube Shorts senaryosu yazan bir editörsün. ' +
  'Yalnızca istenen JSON nesnesini döndür. Uydurma kelime, başka dil veya açıklama ekleme. ' +
  'Cümlelerin içine şablon etiketi (Kanca cümlesi, Soru cümlesi, Sebep 1 gibi) yazma.';

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/…{2,}/g, '…')
    .replace(/\.{3,}/g, '…')
    .replace(/!{2,}/g, '!')
    .replace(/\?{2,}/g, '?')
    .replace(/\s+([.,!?…])/g, '$1')
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

function ensureSentenceEnd(text) {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

// ------------------------------------------------------------- temizlik

// Modelin prompt'tan kopyaladığı şablon etiketleri: "Kanca cümlesi:",
// "Soru cümlesi:", "1) ", "Sebep 1:", "KAPANIŞ:" gibi.
const PROMPT_LABEL_RE =
  /^\s*(?:\d{1,2}\s*[).:–-]\s*)?(?:kanca(?:\s+cümlesi)?|soru(?:\s+cümlesi)?|sebep(?:ler)?(?:\s*\d)?|neden(?:ler)?(?:\s*\d)?|kapanış(?:\s+sorusu)?|giriş|sonuç|hook|question|reasons?\s*\d?|intro|closing)\s*[:：]\s*/i;

const INLINE_LABEL_RE =
  /\b(?:kanca|soru)\s+cümlesi\s*[:：]|\bsebep(?:ler)?\s*\d*\s*[:：]|\bkapanış\s+sorusu\s*[:：]/gi;

// Cümle yarıda kalmışsa sonu bunlardan biriyle biter
const DANGLING_END_RE =
  /(?:[,;:]|…|\b(?:ve|veya|ama|fakat|ancak|çünkü|ki|ile|için|gibi|olarak|daha|bir|bu|şu|en))\s*$/i;

/** Prompt etiketlerini cümlenin başından ve içinden temizler. */
export function stripPromptLabels(value) {
  let out = String(value ?? '');
  for (let i = 0; i < 4; i += 1) {
    const next = out
      .replace(PROMPT_LABEL_RE, '')
      .replace(/^\s*[-*•)\]]\s*/, '')
      .replace(INLINE_LABEL_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/** Cümle altyazıya konabilir mi? (etiket artığı, yarım cümle, çok kısa) */
export function isUsableSentence(value) {
  const text = cleanText(stripPromptLabels(value));
  if (!text) return { ok: false, text: '', reason: 'boş' };
  if (/\bcümlesi\b/i.test(text)) return { ok: false, text, reason: 'etiket' };
  if (countWords(text) < MIN_ITEM_WORDS) return { ok: false, text, reason: 'çok kısa' };
  if (DANGLING_END_RE.test(text)) return { ok: false, text, reason: 'yarım cümle' };
  return { ok: true, text: ensureSentenceEnd(text), reason: null };
}

// ------------------------------------------------------------- etiket (bant yazısı)

const LABEL_STOPWORDS = new Set([
  'ama', 'ancak', 'fakat', 'çünkü', 'veya', 'ile', 'için', 'gibi', 'olarak', 'daha', 'değil',
  'olan', 'olarak', 'diye', 'kadar', 'sonra', 'önce', 'üzerine', 'hakkında', 'bunlar', 'şeyler',
  'mesela', 'yani', 'herkes', 'birçok', 'sadece', 'zaten', 'hemen', 'belki', 'bile', 'artık',
  'this', 'that', 'with', 'from', 'they', 'their'
]);

function normalizeTr(text) {
  return String(text || '').toLocaleLowerCase('tr');
}

function stem(word) {
  return normalizeTr(word).slice(0, 5);
}

function fitLabel(value) {
  const text = cleanText(value).toLocaleUpperCase('tr');
  if (!text) return null;
  if (text.length > LABEL_MAX_CHARS) return null;
  if (countWords(text) > 3) return null;
  return text;
}

/**
 * Modelin `title` alanı cümlenin içinden bir vurgu mu, yoksa uydurma mı?
 * Sadece cümlede geçen (ilk 5 harfi tutan) 1-2 kelimelik ifadeler kabul edilir.
 */
export function validateTitle(title, text) {
  const candidate = fitLabel(title);
  if (!candidate) return null;
  const sentence = normalizeTr(text);
  const words = normalizeTr(candidate)
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  if (!words.length) return null;
  const hit = words.some((w) => sentence.includes(stem(w)));
  return hit ? candidate : null;
}

/**
 * Bant yazısı üretir: önce cümledeki sayı + birim, sonra konunun ana kelimesi.
 * Hiçbiri yoksa null döner (bant çizilmez) — uydurma kelime yazılmaz.
 */
export function deriveLabel(text, topic = '') {
  const sentence = cleanText(text);
  if (!sentence) return null;

  const numberMatch = sentence.match(
    /(%\s?\d{1,4}|\d{1,4}(?:[.,]\d{1,2})?\s*(?:yıl|yil|kat|bin|milyon|milyar|derece|saat|gün|gun|hafta|saniye|dakika|kilo|metre|kilometre|km|kişi|kisi|ülke|ulke|kez|parça|parca|tür|tur))/i
  );
  if (numberMatch) {
    const label = fitLabel(numberMatch[0].replace(/\s+/g, ' '));
    if (label) return label;
  }

  const topicWords = cleanText(topic)
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !LABEL_STOPWORDS.has(normalizeTr(w)));

  const lower = normalizeTr(sentence);
  const found = topicWords.find((word) => lower.includes(stem(word)));
  if (found) return fitLabel(found);

  return null;
}

function assignLabels(items, topic) {
  const used = new Map();
  return items.map((item) => {
    const label = validateTitle(item.labelHint, item.text) || deriveLabel(item.text, topic);
    if (!label) return null;
    const count = used.get(label) || 0;
    if (count >= 2) return null;
    used.set(label, count + 1);
    return label;
  });
}

// ------------------------------------------------------------- öğeler

/** Modelin "sentences" dizisini tek biçime çevirir. */
export function normalizeItems(raw) {
  const list = Array.isArray(raw?.sentences)
    ? raw.sentences
    : (Array.isArray(raw?.items) ? raw.items : []);

  return list
    .map((item) => (typeof item === 'string' ? { text: item } : item || {}))
    .map((item) => ({
      text: cleanText(item.text ?? item.narration ?? item.cumle ?? item.sentence),
      // Görsel tarifi: cümlenin ne anlattığını sahneye çevirmek için kullanılır
      visual: cleanText(item.visual ?? item.visual_prompt ?? item.scene ?? item.gorsel),
      labelHint: cleanText(item.title ?? item.label ?? item.etiket)
    }))
    .filter((item) => item.text);
}

/** Etiket artıklarını siler, yarım/çok kısa cümleleri atar. */
export function sanitizeItems(items) {
  const out = [];
  let dropped = 0;
  let reason = null;
  for (const item of items) {
    const verdict = isUsableSentence(item.text);
    if (!verdict.ok) {
      dropped += 1;
      reason = verdict.reason;
      continue;
    }
    out.push({ ...item, text: verdict.text });
  }
  if (dropped > 0) {
    log('ScriptAgent', `${dropped} cümle atıldı (son sebep: ${reason}).`, 'WARN');
  }
  return out;
}

function tokenSet(text) {
  return new Set(
    normalizeTr(text)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

/** Birebir değil, anlamca tekrar eden cümleleri de ayıklar. */
function dedupeItems(items) {
  const kept = [];
  for (const item of items) {
    const tokens = tokenSet(item.text);
    if (!tokens.size) continue;
    const duplicate = kept.some((other) => {
      const otherTokens = tokenSet(other.text);
      if (!otherTokens.size) return false;
      let common = 0;
      for (const token of tokens) if (otherTokens.has(token)) common += 1;
      const union = new Set([...tokens, ...otherTokens]).size;
      return common / union >= 0.72;
    });
    if (!duplicate) kept.push(item);
  }
  return kept;
}

export function itemsToScript(items, meta = {}) {
  const narration = items.map((item) => item.text).join(' ');
  const anyVisual = items.some((item) => item.visual && item.visual.trim());

  return {
    title: cleanText(meta.title).replace(/#shorts/gi, '').trim(),
    description: cleanText(meta.description),
    tags: Array.isArray(meta.tags) ? meta.tags.map(cleanText).filter(Boolean) : [],
    narration,
    // Görsel tarifleri sahne planına ipucu olarak gider; eksikler null olur
    sceneHints: anyVisual ? items.map((item) => item.visual || null) : null,
    labels: items.map((item) => item.label || null),
    visualQueries: Array.isArray(meta.visualQueries) && meta.visualQueries.length === 4
      ? meta.visualQueries.map(cleanText)
      : []
  };
}

/** Geriye dönük uyumluluk: eski tek-yanıt biçimini (narration/sceneHints) da anlar. */
export function normalizeScript(raw) {
  const items = sanitizeItems(normalizeItems(raw));
  const script = itemsToScript(items, raw || {});

  if (!script.narration && typeof raw?.narration === 'string') {
    const sentences = splitSentences(raw.narration);
    script.narration = cleanText(raw.narration);
    if (Array.isArray(raw.sceneHints)) {
      const hints = raw.sceneHints.map(cleanText);
      script.sceneHints = hints.length === sentences.length ? hints : null;
    }
    if (Array.isArray(raw.labels)) {
      const labels = raw.labels.map((label) => (label ? cleanText(label) : null));
      script.labels = labels.length === sentences.length ? labels : null;
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
      'Konuyu üç somut ve birbirinden farklı ana fikre böl. Her fikir tek cümle olsun.',
      'Dil Türkçe, anlaşılır ve gündelik olsun. Emin olmadığın bilgiyi yazma.',
      '',
      'Yalnızca şu JSON biçimini döndür:',
      '{"title":"en fazla 70 karakter",',
      ' "description":"1-2 cümle",',
      ' "tags":["...","...","..."],',
      ' "hook":"izleyiciyi tutan ilk cümle (9-11 kelime)",',
      ' "reasons":["birinci ana fikir","ikinci ana fikir","üçüncü ana fikir"],',
      ' "closing":"kapanış sorusu (9-11 kelime)"}'
    ].filter(Boolean).join('\n');

    const raw = await this.call(prompt, { temperature: 0.7, numPredict: 400, label: 'plan' });

    const reasons = Array.isArray(raw.reasons)
      ? raw.reasons.map((item) => cleanText(item)).filter(Boolean).slice(0, 3)
      : [];

    return {
      title: cleanText(raw.title) || cleanText(topicObj.topic),
      description: cleanText(raw.description),
      tags: Array.isArray(raw.tags) ? raw.tags.map((item) => cleanText(item)).filter(Boolean) : [],
      hook: stripPromptLabels(cleanText(raw.hook)),
      reasons,
      closing: stripPromptLabels(cleanText(raw.closing))
    };
  }

  /** 2. adım: planın bir bölümünü cümlelere döker. */
  async writePart(topicObj, outline, part) {
    const reason = (index) => outline.reasons[index] || `konunun ${index + 1}. yönü`;
    const sections = part.reasonIndexes
      .map((index) => `- "${reason(index)}" fikri için ${part.perReason} cümle`)
      .join('\n');

    const intro = part.includeIntro
      ? [
        outline.hook
          ? `İlk cümle şu fikri anlatsın (kelimesi kelimesine kopyalama): "${outline.hook}"`
          : 'İlk cümle izleyiciyi şaşırtan bir bilgi versin.',
        'İkinci cümle izleyiciye doğrudan bir soru sorsun.'
      ]
      : ['Bu bölümde giriş ve soru YOK; doğrudan ana fikirlere geç.'];

    const target = part.includeIntro ? PART_SENTENCES : 6;

    const prompt = [
      `Konu: "${topicObj.topic}" (Kategori: ${topicObj.category})`,
      `Video başlığı: ${outline.title}`,
      '',
      'Bu bölüm için Türkçe cümleler yaz:',
      ...intro,
      'Ana fikirler:',
      sections,
      '',
      `Toplam TAM ${target} cümle yaz. Eksik cümle bırakma.`,
      `Her cümle ${WORDS_PER_SENTENCE} kelime olsun; 8'den kısa, 12'den uzun olmasın.`,
      'Cümleler birbirini tekrar etmesin.',
      '',
      'ÇOK ÖNEMLİ:',
      '- Cümlelerin içine "Kanca cümlesi:", "Soru cümlesi:", "Sebep 1:", "1)" gibi ETİKET YAZMA.',
      '- Her cümle kendi başına tam ve noktalamalı olsun; üç nokta ile yarım bırakma.',
      '',
      'Her cümle için:',
      '- "text": cümlenin kendisi.',
      '- "visual": beyaz tahtaya çizilecek TEK somut sahne, 3-8 kelime. Cümlenin anlattığı',
      '  eylemi/nesneyi göster (ör. "bardağa dökülen su", "iki dil arasında köprü", "buz küpü eriyor").',
      '  Sadece anahtar kelime yazma; cümlenin ne anlattığını tarif et.',
      '- "title": tahtaya yazılacak 1-2 kelimelik vurgu. Cümlede sayı varsa sayıyı yaz',
      '  ("%40", "3 KAT"); yoksa cümledeki en önemli kelime ("TUZ", "KÖPRÜ"). Emin değilsen boş bırak.',
      '',
      'Yalnızca şu JSON biçimini döndür:',
      '{"sentences":[{"text":"...","visual":"...","title":"..."}]}'
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
      'Cümlelerin içine etiket ("Sebep 2:" gibi) yazma; cümleler tam ve noktalamalı olsun.',
      '',
      'Yalnızca JSON: {"sentences":[{"text":"...","visual":"...","title":"..."}]}'
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

    let items = dedupeItems(sanitizeItems([...partA, ...partB]));

    const words = () => countWords(items.map((item) => item.text).join(' '));
    log('ScriptAgent', `İlk taslak: ${items.length} cümle, ${words()} kelime.`);

    // Kısa kaldıysa en fazla iki tur ek cümle iste
    for (let attempt = 1; attempt <= MAX_EXTEND_ATTEMPTS && words() < MIN_WORDS; attempt += 1) {
      const missing = MIN_WORDS - words();
      log('ScriptAgent', `${missing} kelime eksik; ek cümleler isteniyor (${attempt}).`, 'WARN');
      const extra = await this.extendItems(topicObj, outline, items, missing);
      items = dedupeItems(sanitizeItems([...items, ...extra]));
    }

    if (outline.closing) {
      const closing = isUsableSentence(outline.closing);
      const alreadyThere = items.some((item) => item.text === closing.text);
      if (closing.ok && !alreadyThere) {
        items.push({
          text: closing.text,
          visual: 'soru işareti ve meraklı gözler',
          labelHint: ''
        });
      }
    }

    const labels = assignLabels(items, topicObj.topic);
    items = items.map((item, index) => ({ ...item, label: labels[index] }));

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

    const labelCount = script.labels.filter(Boolean).length;
    log(
      'ScriptAgent',
      `Senaryo hazır: "${script.title}" (${wordCount} kelime, ${items.length} cümle, ` +
      `${labelCount} bant yazısı, ~${estimateSeconds(script.narration).toFixed(0)} sn).`
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
  partSentences: PART_SENTENCES,
  minItemWords: MIN_ITEM_WORDS
};
