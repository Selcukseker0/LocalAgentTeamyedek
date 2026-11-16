import { askLLM } from '../llm/provider.js';
import { log } from '../logger.js';
import { cleanText, countWords, splitSentences } from '../utils/text.js';

// Eski çağrı yerleri bozulmasın: yardımcılar buradan da erişilebilir.
export { cleanText, countWords, splitSentences };

// Hedef: 45-60 saniyelik Shorts. edge-tts (+20% hız) Türkçe için yaklaşık
// saniyede 2.9 kelime okuyor; TTS_WORDS_PER_SECOND ile kalibre edilebilir.
const WPS = Number(process.env.TTS_WORDS_PER_SECOND || 2.9);
const TARGET_MIN_SEC = 30;
const TARGET_MAX_SEC = 45;

const MIN_WORDS = Math.round(TARGET_MIN_SEC * WPS * 1.0);    // 87
const MAX_WORDS = Math.round(TARGET_MAX_SEC * WPS * 0.98);   // 128
// Bu sınırın altında video hedeften kısa kalır ama üretim durmaz
const ACCEPT_MIN_WORDS = Math.round(TARGET_MIN_SEC * WPS * 0.86); // ~75

const PART_SENTENCES = 7;
const MIN_SENTENCE_WORDS = 6;
const MAX_SENTENCE_WORDS = 16;

// Sahnelerin çizilebilir olması için: soyut sıfat/isim yasak.
// Bunlar cümleye girince görsel model ne çizeceğini bilemez.
const ABSTRACT_WORDS = [
  'gizemli', 'gizem', 'ilginç', 'enteresan', 'harika', 'inanılmaz', 'şaşırtıcı', 'muhteşem',
  'büyüleyici', 'etkileyici', 'olağanüstü', 'efsanevi', 'büyülü', 'sıra dışı', 'akıl almaz',
  'dikkat çekici', 'merak uyandıran', 'fascinating', 'interesting', 'amazing', 'mysterious'
];
// \b ASCII tabanlı: Türkçe harfle biten kelimeler (ilginç, şaşırtıcı) eşleşmiyor.
// Bu yüzden Unicode harf sınırı + yaygın Türkçe çekim ekleri kullanılır
// ("gizemliydi", "ilginçti" de yakalanır).
const ABSTRACT_SUFFIXES =
  '(?:ydi|ydı|ydü|ydu|dir|dır|dür|dur|lik|lık|lük|luk|dı|di|du|dü|ti|tı|te|ta|ce|ca|si|sı|sü|su)?';
const ABSTRACT_BODY = `(?:${ABSTRACT_WORDS.join('|')})${ABSTRACT_SUFFIXES}`;
const ABSTRACT_RE = new RegExp(`(?<!\\p{L})${ABSTRACT_BODY}(?!\\p{L})`, 'iu');

export function findAbstractWords(text) {
  const matches = String(text || '').match(new RegExp(ABSTRACT_RE.source, 'giu'));
  return matches ? [...new Set(matches.map((item) => item.toLocaleLowerCase('tr')))] : [];
}
const MAX_REGEN = 2;
// Toplam senaryo bütçesi: model yavaşsa (7b, CPU) 20 dakika beklemek yerine
// elde olanla devam edilir.
const SCRIPT_BUDGET_MS = Number(process.env.SCRIPT_BUDGET_SEC || 600) * 1000;
// Bu eşiğin altındaki sayılar (0-99) kaynak denetiminden muaf
const GROUNDING_MIN_NUMBER = Number(process.env.GROUNDING_MIN_NUMBER || 10);
// Editör puanı bunun altındaysa senaryo bir kez daha yazdırılır.
const CRITIQUE_MIN_SCORE = Number(process.env.SCRIPT_MIN_SCORE || 7);
const LABEL_MAX_CHARS = 18;

const SYSTEM_PROMPT =
  'Sen Türkçe YouTube Shorts senaryosu yazan bir editörsün. ' +
  'Yalnızca istenen JSON nesnesini döndür. Cümle içine etiket, numara, başlık veya ' +
  'açıklama yazma; sadece seslendirilecek tam cümleleri yaz. Uydurma bilgi verme.';

// ---------------------------------------------------------------- metin araçları

export function estimateSeconds(narration) {
  return countWords(narration) / WPS;
}

function ensureSentenceEnd(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// ---------------------------------------------------------------- etiket temizliği

// Modelin prompt'tan kopyaladığı şablon etiketleri ve numaralandırma:
// "3):", "4)", "Kanca cümlesi:", "Soru:", "Sebep 2 -", "1."
const LEADING_NUMBER_RE = /^\s*\(?\d{1,2}\s*[).:\-–—]\s*/;
const PROMPT_LABEL_RE =
  /^\s*(?:\(?\d{1,2}\s*[).:\-–—]\s*)?(?:kanca(?:\s+cümlesi)?|soru(?:\s+cümlesi)?|sebep(?:ler)?(?:\s*\d)?|neden(?:ler)?(?:\s*\d)?|kapanış(?:\s+sorusu)?|giriş|sonuç|hook|question|reasons?\s*\d?|intro|closing)\s*(?:[:：\-–—]|\))\s*/i;

const INLINE_LABEL_RE =
  /\b(?:kanca|soru)\s+cümlesi\b\s*[:：]?|\bsebep(?:ler)?\s*\d*\s*[:：]|\bkapanış\s+sorusu\s*[:：]/gi;

const DANGLING_END_RE =
  /(?:[,;:]|…|\b(?:ve|veya|ama|fakat|ancak|çünkü|ki|ile|için|gibi|olarak|daha|bir|bu|şu|en|de|da|mi|mı|mu|mü))\s*$/i;

/** Cümlenin başındaki/sonundaki şablon artıklarını temizler. */
export function stripPromptLabels(value) {
  let out = String(value ?? '');
  for (let i = 0; i < 5; i += 1) {
    const next = out
      .replace(PROMPT_LABEL_RE, '')
      .replace(LEADING_NUMBER_RE, '')
      .replace(/^\s*[-*•)\]]\s*/, '')
      .replace(INLINE_LABEL_RE, '')
      .trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

const BANNED_WORDS = /\b(kanca|hook|sebep|soru cümlesi|kapanış|narration|visual|prompt|title|json)\b/i;

/** Cümle seslendirmeye uygun mu? Sorun varsa sebebini döner. */
export function checkSentence(value) {
  const raw = cleanText(stripPromptLabels(value));
  if (!raw) return { ok: false, text: '', reason: 'boş cümle' };
  if (BANNED_WORDS.test(raw)) return { ok: false, text: raw, reason: 'etiket kelimesi' };
  if (/[:：]/.test(raw)) return { ok: false, text: raw, reason: 'iki nokta' };
  if (/^[\d)\-–—*]/.test(raw)) return { ok: false, text: raw, reason: 'numara' };
  if (/…/.test(raw)) return { ok: false, text: raw, reason: 'yarım cümle (…)' };
  if (DANGLING_END_RE.test(raw)) return { ok: false, text: raw, reason: 'yarım cümle' };

  const words = countWords(raw);
  if (words < MIN_SENTENCE_WORDS) return { ok: false, text: raw, reason: `çok kısa (${words})` };
  if (words > MAX_SENTENCE_WORDS) return { ok: false, text: raw, reason: `çok uzun (${words})` };
  if (!/[.!?]$/.test(raw)) return { ok: false, text: raw, reason: 'noktalama yok' };
  return { ok: true, text: ensureSentenceCase(raw), reason: null };
}

/**
 * Uzun cümleyi virgül / bağlaç sınırlarından böler: model 20-30 kelime yazsa da
 * cümle atılmaz, iki kısa cümleye dönüşür. Bağlaç korunur ("... ve bu yüzden ...").
 */
const CLAUSE_SEP = /(,\s*|;\s*|\s+(?:ama|ancak|fakat|çünkü|bu yüzden|bu sayede|dolayısıyla|ve)\s+)/i;
const LEADING_CONJ = /^(?:ve|ama|ancak|fakat|çünkü|bu yüzden|bu sayede|dolayısıyla)\s+/i;
const CONJ_SEP = /\s+(ama|ancak|fakat|çünkü|bu yüzden|bu sayede|dolayısıyla|ve)\s+$/i;

function capitalizeTr(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const first = trimmed.charAt(0);
  return first === first.toLocaleUpperCase('tr') ? trimmed : first.toLocaleUpperCase('tr') + trimmed.slice(1);
}

/** Tek başına uzun kalan parçayı kelime sınırından böler. */
function hardSplit(clause, maxWords) {
  const tokens = clause.split(/\s+/);
  const chunk = Math.max(MIN_SENTENCE_WORDS, Math.floor(maxWords * 0.9));
  const pieces = [];
  for (let i = 0; i < tokens.length; i += chunk) {
    const part = tokens.slice(i, i + chunk).join(' ').trim();
    if (countWords(part) >= 3) pieces.push(part);
  }
  return pieces;
}

const CONJUNCTIONS = new Set(['ama', 'ancak', 'fakat', 'çünkü', 'bu yüzden', 'bu sayede', 'dolayısıyla', 've']);

export function splitLongSentence(text, maxWords = MAX_SENTENCE_WORDS) {
  const raw = cleanText(text);
  if (!raw) return [];
  if (countWords(raw) <= maxWords) return [raw];

  const body = raw.replace(/[.!?]+$/, '').trim();

  // Ayraçları sırayla tara: {text, sepBefore} listesi
  const scanner = new RegExp(CLAUSE_SEP.source, 'gi');
  const clauses = [];
  let pendingSep = '';
  let lastIndex = 0;
  for (const match of body.matchAll(scanner)) {
    const clauseText = body.slice(lastIndex, match.index).trim();
    if (clauseText) clauses.push({ text: clauseText, sepBefore: pendingSep });
    pendingSep = match[1].trim();
    lastIndex = match.index + match[0].length;
  }
  const tail = body.slice(lastIndex).trim();
  if (tail) clauses.push({ text: tail, sepBefore: pendingSep });

  const sentences = [];
  let current = '';
  const flush = () => {
    const value = current.trim();
    if (value) sentences.push(value);
    current = '';
  };

  for (const clause of clauses) {
    const pieces = countWords(clause.text) <= maxWords ? [clause.text] : hardSplit(clause.text, maxWords);
    for (const [index, piece] of pieces.entries()) {
      const sep = index === 0 ? clause.sepBefore : ',';
      if (!current) {
        current = capitalizeTr(piece.replace(LEADING_CONJ, ''));
        continue;
      }
      let candidate;
      if (CONJUNCTIONS.has(sep.toLocaleLowerCase('tr'))) candidate = `${current} ${sep} ${piece}`;
      else if (sep) candidate = `${current}, ${piece}`;
      else candidate = `${current} ${piece}`;

      if (countWords(candidate) > maxWords) {
        flush();
        current = capitalizeTr(piece.replace(LEADING_CONJ, ''));
      } else {
        current = candidate;
      }
    }
  }
  flush();

  // Kısa kırıntıları komşusuna ekle, baş harf ve noktayı düzelt
  const result = [];
  for (const sentence of sentences) {
    const clean = capitalizeTr(sentence.replace(/[,;]+$/, '').trim());
    if (result.length && countWords(clean) < MIN_SENTENCE_WORDS) {
      const previous = result[result.length - 1];
      if (countWords(`${previous} ${clean}`) <= maxWords) {
        result[result.length - 1] = `${previous} ${clean}`;
        continue;
      }
    }
    result.push(clean);
  }

  return result
    .map((sentence) => `${sentence.replace(/[.,;]+$/, '').trim()}.`)
    .filter((sentence) => countWords(sentence) >= MIN_SENTENCE_WORDS);
}

/** Kısa cümleyi öncekine eklerken iki nokta değil virgül kullanır. */
export function joinSentences(first, second) {
  const head = String(first || '').trim().replace(/[.!?]+$/, '');
  const tail = String(second || '').trim().replace(/[.!?]+$/, '');
  if (!tail) return `${head}.`;
  const soft = tail.charAt(0) === tail.charAt(0).toLocaleLowerCase('tr')
    ? tail
    : tail.charAt(0).toLocaleLowerCase('tr') + tail.slice(1);
  return `${head}, ${soft}.`;
}

function ensureSentenceCase(text) {
  const first = text.charAt(0);
  return first === first.toLocaleUpperCase('tr') ? text : first.toLocaleUpperCase('tr') + text.slice(1);
}

// ---------------------------------------------------------------- bant yazısı

const LABEL_STOPWORDS = new Set([
  'ama', 'ancak', 'fakat', 'çünkü', 'veya', 'ile', 'için', 'gibi', 'olarak', 'daha', 'değil',
  'olan', 'diye', 'kadar', 'sonra', 'önce', 'üzerine', 'hakkında', 'bunlar', 'şeyler',
  'mesela', 'yani', 'herkes', 'birçok', 'sadece', 'zaten', 'hemen', 'belki', 'bile', 'artık'
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
  if (/[^\p{L}\p{N}%\s.,'-]/u.test(text)) return null;
  return text;
}

/** Modelin `title` alanı cümlede geçiyorsa (veya sayıysa) kabul edilir. */
export function validateTitle(title, narration) {
  const candidate = fitLabel(title);
  if (!candidate) return null;
  const sentence = normalizeTr(narration);
  const words = normalizeTr(candidate).split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) return null;
  // Cümlede geçmeyen uydurma etiket kabul edilmez
  return words.some((w) => sentence.includes(stem(w))) ? candidate : null;
}

/** Cümledeki sayı veya konunun ana kelimesinden etiket üretir. */
export function deriveLabel(narration, topic = '') {
  const sentence = cleanText(narration);
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
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !LABEL_STOPWORDS.has(normalizeTr(word)));

  const lower = normalizeTr(sentence);
  // Konu kelimesi tam hâliyle geçmeli ("bozulmaz" -> "bozulduğunu" eşleşmesin)
  const found = topicWords.find((word) => lower.includes(normalizeTr(word)));
  return found ? fitLabel(found) : null;
}

// ---------------------------------------------------------------- sahne öğeleri

/** Modelin döndürdüğü sahne dizisini tek biçime çevirir. */
export function normalizeScenes(raw) {
  const list = Array.isArray(raw?.scenes)
    ? raw.scenes
    : (Array.isArray(raw?.sentences) ? raw.sentences : (Array.isArray(raw) ? raw : []));

  return list
    .map((item) => (typeof item === 'string' ? { narration: item } : item || {}))
    .map((item) => ({
      narration: cleanText(item.narration ?? item.text ?? item.cumle ?? item.sentence),
      imagePrompt: cleanText(
        item.image_prompt ?? item.imagePrompt ?? item.visual_prompt ?? item.visualPrompt
        ?? item.visual ?? item.scene ?? ''
      ),
      visualObjects: (Array.isArray(item.visual_objects)
        ? item.visual_objects
        : (Array.isArray(item.visualObjects) ? item.visualObjects
          : (Array.isArray(item.objects) ? item.objects : [])))
        .map((obj) => cleanText(typeof obj === 'string' ? obj : obj?.name || ''))
        .filter(Boolean)
        .slice(0, 5),
      titleHint: cleanText(item.title ?? item.label ?? item.etiket ?? '')
    }))
    .filter((item) => item.narration);
}

/** Etiket artıklı / yarım cümleleri ayıklar. */
export function sanitizeScenes(scenes) {
  const kept = [];
  const reasons = new Map();
  let split = 0;
  let merged = 0;
  let pendingShort = null;   // sonraki geçerli cümleye eklenecek kısa parça
  let lastScene = null;

  const pushText = (scene, text) => {
    const value = capitalizeTr(text.trim());
    if (!value) return;
    if (pendingShort) {
      const together = joinSentences(pendingShort, value);
      if (countWords(together) <= MAX_SENTENCE_WORDS) {
        kept.push({ ...scene, narration: together });
        merged += 1;
        pendingShort = null;
        return;
      }
      pendingShort = null;   // sığmadı, kısa parça düşer
    }
    kept.push({ ...scene, narration: value });
  };

  const drop = (reason) => reasons.set(reason, (reasons.get(reason) || 0) + 1);

  for (const scene of scenes) {
    const verdict = checkSentence(scene.narration);
    lastScene = scene;

    if (verdict.ok) {
      pushText(scene, verdict.text);
      continue;
    }

    // Model 16 kelimeden uzun yazdı: cümleyi atma, böl
    if (verdict.reason?.startsWith('çok uzun')) {
      const valid = splitLongSentence(scene.narration)
        .map((piece) => checkSentence(piece))
        .filter((piece) => piece.ok);
      if (valid.length) {
        split += 1;
        valid.forEach((piece) => pushText(scene, piece.text));
        continue;
      }
    }

    // Çok kısa cümle: öncekine ekle; olmuyorsa sonrakine eklemek için beklet
    if (verdict.reason?.startsWith('çok kısa') && verdict.text) {
      const previous = kept[kept.length - 1];
      if (previous) {
        const together = joinSentences(previous.narration, verdict.text);
        if (countWords(together) <= MAX_SENTENCE_WORDS) {
          previous.narration = together;
          merged += 1;
          continue;
        }
      }
      if (!pendingShort) {
        pendingShort = verdict.text;
        merged += 1;   // sayıma "birleştirildi" olarak yazılır
        continue;
      }
      pendingShort = joinSentences(pendingShort, verdict.text);
      continue;
    }

    drop(verdict.reason);
  }

  // Sonda kalan kısa parça: öncekine ekle, olmuyorsa tek cümle olarak tut
  if (pendingShort) {
    const previous = kept[kept.length - 1];
    const together = previous ? joinSentences(previous.narration, pendingShort) : '';
    if (previous && countWords(together) <= MAX_SENTENCE_WORDS) {
      previous.narration = together;
    } else {
      kept.push({ ...(lastScene || {}), narration: capitalizeTr(pendingShort) });
    }
    pendingShort = null;
  }

  if (split) log('ScriptAgent', `${split} uzun cümle ikiye bölündü.`, 'INFO');
  if (merged) log('ScriptAgent', `${merged} kısa cümle komşusuna eklendi.`, 'INFO');
  if (reasons.size) {
    const summary = [...reasons.entries()].map(([reason, n]) => `${reason}×${n}`).join(', ');
    log('ScriptAgent', `Bozuk cümleler atıldı: ${summary}.`, 'WARN');
  }
  return kept;
}

function tokenSet(text) {
  return new Set(
    normalizeTr(text)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2)
  );
}

/** Birebir değil, kelime örtüşmesine göre tekrar eden cümleleri ayıklar. */
export function dedupeScenes(scenes, threshold = 0.7) {
  const kept = [];
  let removed = 0;
  for (const scene of scenes) {
    const tokens = tokenSet(scene.narration);
    if (!tokens.size) continue;
    const duplicate = kept.some((other) => {
      const otherTokens = tokenSet(other.narration);
      if (!otherTokens.size) return false;
      let common = 0;
      for (const token of tokens) if (otherTokens.has(token)) common += 1;
      return common / new Set([...tokens, ...otherTokens]).size >= threshold;
    });
    if (duplicate) {
      removed += 1;
      continue;
    }
    kept.push(scene);
  }
  if (removed) log('ScriptAgent', `${removed} tekrar eden cümle atıldı.`, 'WARN');
  return kept;
}

/** "3.000" / "3 000" / "3000" aynı sayı; "2,5" ondalık. */
export function canonicalNumber(raw) {
  const text = String(raw || '').trim();
  if (/^\d{1,3}(?:[. ]\d{3})+$/.test(text)) {
    return String(Number(text.replace(/[. ]/g, '')));
  }
  if (/^\d+,\d+$/.test(text)) {
    return String(Number(text.replace(',', '.')));
  }
  return String(Number(text.replace(/\./g, '')) || 0);
}

/**
 * Sayılar kaynakta geçiyor mu? Sadece ANLAMLI sayılar denetlenir:
 * 0-99 arası sayılar ("2 dakika", "%5") yaygın olduğu için serbest,
 * 100 ve üzeri (yıl, nüfus, ölçü) kaynakta yoksa halüsinasyon sayılır.
 */
export function checkGrounding(scenes, facts = [], minChecked = 100) {
  const problems = [];
  const warnings = [];
  const source = (facts || []).join(' ').replace(/\s+/g, ' ');
  if (!source) return { problems, warnings };

  const NUMBERS_RE = /\d{1,3}(?:[. ]\d{3})+|\d+(?:[.,]\d+)?/g;
  const sourceNumbers = new Set(
    (source.match(NUMBERS_RE) || []).map((item) => canonicalNumber(item))
  );

  const ungrounded = [];
  for (const [index, scene] of (scenes || []).entries()) {
    const numbers = (String(scene.narration || '').match(NUMBERS_RE) || [])
      .map((item) => canonicalNumber(item))
      .filter((num) => Number(num) >= minChecked);
    const foreign = [...new Set(numbers)].filter((num) => !sourceNumbers.has(num));
    if (foreign.length) ungrounded.push(`${index + 1}. sahne (${foreign.join(', ')})`);
  }

  if (ungrounded.length >= 2) {
    problems.push(`kaynakta olmayan sayı: ${ungrounded.slice(0, 3).join(', ')}`);
  } else if (ungrounded.length === 1) {
    warnings.push(`kaynakta olmayan sayı: ${ungrounded[0]}`);
  }
  return { problems, warnings };
}

/**
 * Render'dan önceki otomatik kontrol: etiket, numara, yarım cümle, tekrar,
 * soyut kelime, kaynak uyumu.
 * @returns {{ok: boolean, problems: string[], warnings: string[]}}
 */
export function validateScript(scenes, { facts = [] } = {}) {
  const problems = [];
  const warnings = [];
  if (!Array.isArray(scenes) || scenes.length < 8) {
    problems.push(`sahne sayısı ${scenes?.length ?? 0} (en az 8 olmalı)`);
  }
  const seen = new Set();
  let missingObjects = 0;
  let fewObjects = 0;
  for (const [index, scene] of (scenes || []).entries()) {
    const no = index + 1;
    const text = scene.narration || '';
    if (/[:：]/.test(text)) problems.push(`${no}. sahnede iki nokta`);
    if (/^\s*\(?\d{1,2}\s*[).:\-–—]/.test(text)) problems.push(`${no}. sahne numarayla başlıyor`);
    if (/\b(kanca|hook|sebep|soru cümlesi|kapanış)\b/i.test(text)) problems.push(`${no}. sahnede etiket`);
    if (/…/.test(text)) problems.push(`${no}. sahne yarım (…)`);
    if (!/[.!?]$/.test(text)) problems.push(`${no}. sahne noktalamasız`);
    const key = normalizeTr(text).replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    if (key && seen.has(key)) problems.push(`${no}. sahne tekrar ediyor`);
    seen.add(key);

    // Çizilebilirlik: soyut kelime varsa görsel model ne çizeceğini bilemez
    const abstract = findAbstractWords(text);
    if (abstract.length) {
      problems.push(`${no}. sahne soyut kelime içeriyor: ${abstract.join(', ')}`);
    }
    const objects = Array.isArray(scene.visualObjects) ? scene.visualObjects.filter(Boolean) : [];
    if (!objects.length) missingObjects += 1;
    else if (objects.length < 2) fewObjects += 1;
  }
  // Aynı ifade üç kez geçiyorsa senaryo kendini tekrar ediyor demektir
  const trigrams = new Map();
  for (const scene of scenes || []) {
    const tokens = normalizeTr(scene.narration)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
    for (let i = 0; i + 2 < tokens.length; i += 1) {
      const key = tokens.slice(i, i + 3).join(' ');
      trigrams.set(key, (trigrams.get(key) || 0) + 1);
    }
  }
  const repeated = [...trigrams.entries()].filter(([, count]) => count >= 3);
  if (repeated.length) {
    problems.push(`tekrar eden ifade: "${repeated[0][0]}" (${repeated[0][1]} kez)`);
  }

  // Her sahnede somut bilgi olmalı: sayı, özel isim veya neden-sonuç
  const concrete = (scenes || []).filter((scene) => {
    const text = scene.narration || '';
    if (/\d/.test(text)) return true;
    if (/(çünkü|bu yüzden|bu sayede|sayesinde|nedeniyle|dolayı)/i.test(text)) return true;
    // Cümle başı dışında büyük harfle başlayan kelime (özel isim)
    return /\S\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]{2,}/.test(text);
  }).length;
  if (scenes?.length && concrete / scenes.length < 0.5) {
    warnings.push(`somut bilgi az (${concrete}/${scenes.length} sahne)`);
  }

  if (missingObjects > 2) {
    warnings.push(`${missingObjects} sahnede çizilebilir nesne yok`);
  }
  if (fewObjects > 3) {
    warnings.push(`${fewObjects} sahnede tek nesne var (2-4 önerilir)`);
  }

  const grounding = checkGrounding(scenes, facts, GROUNDING_MIN_NUMBER);
  problems.push(...grounding.problems);
  warnings.push(...grounding.warnings);

  const words = countWords((scenes || []).map((scene) => scene.narration).join(' '));
  if (words < ACCEPT_MIN_WORDS) problems.push(`toplam ${words} kelime (en az ${ACCEPT_MIN_WORDS})`);
  if (words > MAX_WORDS + 25) problems.push(`toplam ${words} kelime (çok uzun)`);
  return { ok: problems.length === 0, problems, warnings };
}

// ---------------------------------------------------------------- ajan

export class ScriptAgent {

  async call(prompt, { temperature = 0.7, numPredict = 900, label = 'senaryo' } = {}) {
    const startedAt = Date.now();
    const raw = await askLLM({ system: SYSTEM_PROMPT, prompt, json: true, temperature, numPredict });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log('ScriptAgent', `${label}: ${seconds}s.`);
    return raw || {};
  }

  /** 1. adım: konuyu planlar (küçük JSON, model zorlanmaz). */
  async createOutline(topicObj, research, feedback = '') {
    const facts = research?.facts?.length
      ? ['', 'Doğrulanmış bilgiler (bunlara bağlı kal, uydurma):',
        ...research.facts.map((fact) => `- ${fact}`)].join('\n')
      : '';

    const prompt = [
      `Konu: "${topicObj.topic}" (Kategori: ${topicObj.category})`,
      feedback ? `Editör notu: ${feedback}` : '',
      facts,
      '',
      '30-45 saniyelik dikey bir Shorts planla.',
      'Yapı: ilk 2 saniyede merak uyandıran kısa bir giriş, ortada 4 net bilgi,',
      'sonda tek cümlelik kapanış sorusu.',
      'Her bilgi SOMUT olsun: sayı, tarih, isim veya neden-sonuç içersin.',
      'Her bilgi ÇİZİLEBİLİR olsun: içinde bir nesne, hayvan, yer veya kişi geçsin.',
      'Soyut anlatım yapma ("gizemli dünya", "ilginç gerçek" gibi); gözle görülür bir şey anlat.',
      facts ? 'Yalnızca yukarıdaki doğrulanmış bilgileri kullan; yeni bilgi uydurma.' : '',
      'Aynı fikri farklı kelimelerle tekrar etme.',
      'Dil Türkçe, gündelik ve akıcı olsun. Emin olmadığın bilgiyi yazma.',
      '',
      'Yalnızca şu JSON biçimini döndür:',
      '{"title":"en fazla 70 karakter",',
      ' "description":"1-2 cümle",',
      ' "tags":["...","...","..."],',
      ' "hook":"en fazla 8 kelimelik, sayı veya şaşırtıcı bilgi içeren giriş cümlesi",',
      ' "facts":["birinci bilgi","ikinci bilgi","üçüncü bilgi","dördüncü bilgi"],',
      ' "closing":"kapanış sorusu (en fazla 10 kelime)"}'
    ].filter(Boolean).join('\n');

    const raw = await this.call(prompt, { temperature: 0.7, numPredict: 450, label: 'plan' });

    const facts4 = (Array.isArray(raw.facts) ? raw.facts : (Array.isArray(raw.reasons) ? raw.reasons : []))
      .map((item) => cleanText(stripPromptLabels(item)))
      .filter(Boolean)
      .slice(0, 4);

    return {
      title: cleanText(raw.title) || cleanText(topicObj.topic),
      description: cleanText(raw.description),
      tags: Array.isArray(raw.tags) ? raw.tags.map((item) => cleanText(item)).filter(Boolean) : [],
      hook: stripPromptLabels(cleanText(raw.hook)),
      facts: facts4,
      closing: stripPromptLabels(cleanText(raw.closing))
    };
  }

  /** 2. adım: planın bir bölümünü sahne sahne cümlelere döker. */
  async writePart(topicObj, outline, part) {
    const fact = (index) => outline.facts[index] || `konunun ${index + 1}. yönü`;
    const sections = part.factIndexes
      .map((index) => `- "${fact(index)}" bilgisi için ${part.perFact} cümle`)
      .join('\n');

    const intro = part.includeIntro
      ? [
        outline.hook
          ? `İlk cümle bu fikri anlatsın (kopyalama, kendi cümlenle yaz): "${outline.hook}"`
          : 'İlk cümle izleyiciyi şaşırtan bir bilgi versin.',
        'İkinci cümle izleyiciye doğrudan bir soru sorsun.'
      ]
      : ['Bu bölümde giriş ve soru YOK; doğrudan bilgilere geç.'];

    const target = part.includeIntro ? PART_SENTENCES : 6;

    const prompt = [
      `Konu: "${topicObj.topic}" (Kategori: ${topicObj.category})`,
      `Video başlığı: ${outline.title}`,
      '',
      'Bu bölüm için Türkçe cümleler yaz:',
      ...intro,
      'Bilgiler:',
      sections,
      '',
      `Toplam TAM ${target} cümle yaz. Eksik cümle bırakma.`,
      'Her cümle 8-14 kelime olsun; 6 kelimeden kısa, 16 kelimeden uzun olmasın.',
      'Her cümle TEK bir fikir anlatsın (2-4 saniyelik sahne).',
      'Her cümlede SOMUT bilgi olsun: sayı, tarih, isim, yer veya neden-sonuç.',
      'Her cümlede en az bir ÇİZİLEBİLİR somut isim olsun (nesne, hayvan, yer, kişi, araç).',
      'Şu soyut kelimeleri KULLANMA: gizemli, ilginç, harika, inanılmaz, şaşırtıcı, muhteşem,',
      'büyüleyici, etkileyici, efsanevi, sıra dışı, akıl almaz, dikkat çekici, merak uyandıran.',
      'Aynı fikri farklı kelimelerle tekrar etme; her cümle yeni bilgi versin.',
      'Cümlelerde iki nokta (:) kullanma, numaralandırma yapma.',
      '',
      'Her cümle için DÖRT alan yaz:',
      '- "narration": sadece seslendirilecek tam cümle. İçine "Kanca cümlesi:", "1)", "Sebep 2:"',
      '  gibi HİÇBİR etiket veya numara yazma. Cümle nokta/soru işareti ile bitsin.',
      '- "visual_objects": cümlede GEÇEN 2-4 somut nesne (kısa adlar, Türkçe). Örnek:',
      '  ["Mısır vazosu","bal","mezar"]. Cümlede olmayan nesne yazma; soyut kavram yazma.',
      '- "image_prompt": bu nesneleri ve olayı anlatan TEK sahne tarifi (6-16 kelime).',
      '  Cümlenin İÇİNDEKİ nesneleri say: kim/ne, ne yapıyor, nerede. Yazı/rakam isteme.',
      '  Örnek: "3000 yıllık Mısır vazosu ve içindeki bal, mezarın içinde duruyor",',
      '  "buz küpü güneşin altında eriyor, yanında su damlası".',
      '  Sadece tek nesne adı yazma (ör. yalnızca "güneş" yazma); soyut kavram çizdirme.',
      '- "title": tahtaya yazılacak en fazla 3 kelimelik vurgu. Cümlede sayı varsa sayıyı',
      '  ("%40", "3 KAT"), yoksa cümledeki en önemli kelimeyi yaz ("KÖPRÜ"). Emin değilsen boş bırak.',
      '',
      'Yalnızca şu JSON biçimini döndür:',
      '{"scenes":[{"narration":"...","visual_objects":["...","..."],"image_prompt":"...","title":"..."}]}'
    ].join('\n');

    const raw = await this.call(prompt, {
      temperature: part.temperature ?? 0.8,
      numPredict: 900,
      label: part.name
    });

    return normalizeScenes(raw);
  }

  /** Eksik kalan kelimeler için ek sahneler ister. */
  async extendScenes(topicObj, outline, scenes, missingWords) {
    const existing = scenes.map((scene) => scene.narration).join(' ');
    const prompt = [
      `Konu: "${topicObj.topic}"`,
      `Mevcut metin (${countWords(existing)} kelime): ${existing}`,
      '',
      `Bu metne ${Math.ceil(missingWords / 11)} yeni cümle ekle (her biri 9-13 kelime).`,
      'Mevcut cümleleri tekrarlama; yeni ayrıntı, örnek veya karşılaştırma ekle.',
      'Kapanış sorusunu tekrar yazma. Etiket ve numara kullanma.',
      '',
      'Her cümlede yeni ve somut bir bilgi olsun (sayı, isim, neden-sonuç).',
      'Her cümlede en az bir çizilebilir somut isim olsun; soyut kelime (gizemli, ilginç,',
      'şaşırtıcı, inanılmaz) kullanma.',
      'Yalnızca JSON: {"scenes":[{"narration":"...","visual_objects":["..."],' +
      '"image_prompt":"...","title":"..."}]}'
    ].join('\n');

    const raw = await this.call(prompt, { temperature: 0.9, numPredict: 800, label: 'ek cümleler' });
    return normalizeScenes(raw);
  }

  /** Görsel tarifi olmayan sahne için konudan basit bir tarif üretir. */
  fallbackVisual(narration, topic) {
    const label = deriveLabel(narration, topic);
    const shortTopic = cleanText(topic).split(/\s+/).slice(0, 4).join(' ');
    if (label) return `${label.toLocaleLowerCase('tr')} ve konuyla ilgili sahne`;
    return shortTopic ? `${shortTopic} ile ilgili sahne` : 'konuyla ilgili sahne';
  }

  /** Sahnelere bant yazısı ve görsel tarifi atar. */
  prepareScenes(scenes, topic) {
    const used = new Map();
    let fallbackCount = 0;
    let objectFallbackCount = 0;
    const prepared = scenes.map((scene) => {
      const title =
        validateTitle(scene.titleHint, scene.narration) ||
        deriveLabel(scene.narration, topic);
      let label = null;
      if (title) {
        const count = used.get(title) || 0;
        if (count < 2) {
          used.set(title, count + 1);
          label = title;
        }
      }
      let visualPrompt = scene.imagePrompt || '';
      if (!visualPrompt) {
        visualPrompt = this.fallbackVisual(scene.narration, topic);
        fallbackCount += 1;
      }

      // Çizilebilir nesneler: model vermediyse tariften/etiketten türet
      let visualObjects = Array.isArray(scene.visualObjects)
        ? scene.visualObjects.map((item) => cleanText(item)).filter(Boolean).slice(0, 4)
        : [];
      if (!visualObjects.length) {
        visualObjects = visualPrompt
          .split(/[,;.]/)
          .map((part) => cleanText(part))
          .filter((part) => part && part.split(' ').length <= 4)
          .slice(0, 3);
        if (visualObjects.length) objectFallbackCount += 1;
      }

      return {
        narration: scene.narration,
        imagePrompt: visualPrompt,
        visualObjects,
        title: label
      };
    });

    if (fallbackCount) {
      log('ScriptAgent', `${fallbackCount} sahne için çizim tarifi konudan türetildi.`, 'WARN');
    }
    if (objectFallbackCount) {
      log('ScriptAgent', `${objectFallbackCount} sahnenin nesne listesi tariften türetildi.`, 'WARN');
    }
    return prepared;
  }

  buildScript(scenes, outline) {
    const narration = scenes.map((scene) => scene.narration).join(' ');

    return {
      title: outline.title || '',
      description: outline.description || '',
      tags: outline.tags || [],
      narration,
      scenes,
      sceneHints: scenes.map((scene) => scene.imagePrompt || null),
      imagePrompts: scenes.map((scene) => scene.imagePrompt || null),
      sceneObjects: scenes.map((scene) => (Array.isArray(scene.visualObjects) ? scene.visualObjects : [])),
      labels: scenes.map((scene) => scene.title || null),
      visualQueries: []
    };
  }

  /**
   * Senaryoyu üretir; otomatik kontrol geçmezse yeniden yazar.
   * @returns {Promise<object>} script
   */
  async generateScript(topicObj, feedback = '', research = null) {
    let attempt = 0;
    let lastProblems = [];
    let lastScript = null;
    const startedAt = Date.now();
    const overBudget = () => Date.now() - startedAt > SCRIPT_BUDGET_MS;

    while (attempt <= MAX_REGEN && !overBudget()) {
      const outline = await this.createOutline(topicObj, research, feedback);
      const prefix = attempt > 0
        ? `Önceki denemenin sorunları: ${lastProblems.slice(0, 4).join('; ')}.`
        : '';

      const partA = await this.writePart(topicObj, outline, {
        name: 'bölüm 1',
        includeIntro: true,
        factIndexes: [0],
        perFact: 4,
        temperature: 0.75
      });

      const partB = await this.writePart(topicObj, outline, {
        name: 'bölüm 2',
        includeIntro: false,
        factIndexes: [1, 2],
        perFact: 2,
        temperature: 0.85
      });

      let scenes = dedupeScenes(sanitizeScenes([...partA, ...partB]));
      const words = () => countWords(scenes.map((scene) => scene.narration).join(' '));
      log('ScriptAgent', `Taslak: ${scenes.length} cümle, ${words()} kelime.`);

      for (let extra = 0; extra < 2 && words() < MIN_WORDS && !overBudget(); extra += 1) {
        const before = words();
        log('ScriptAgent', `${MIN_WORDS - before} kelime eksik; ek cümle isteniyor.`, 'WARN');
        const more = await this.extendScenes(topicObj, outline, scenes, MIN_WORDS - before);
        scenes = dedupeScenes(sanitizeScenes([...scenes, ...more]));
        if (words() <= before) {
          log('ScriptAgent', 'Ek cümlelerde ilerleme yok; senaryo eldekiyle değerlendirilecek.', 'WARN');
          break;
        }
      }

      // Kapanış sorusu her zaman en sonda
      const closing = checkSentence(outline.closing);
      if (closing.ok) {
        scenes.push({
          narration: closing.text,
          imagePrompt: 'meraklı bir yüz ve büyük bir soru işareti',
          visualObjects: ['soru işareti', 'meraklı yüz'],
          titleHint: ''
        });
      }

      scenes = this.prepareScenes(scenes, topicObj.topic);
      if (prefix) scenes = dedupeScenes(scenes);
      lastScript = this.buildScript(scenes, outline);
      const check = validateScript(lastScript.scenes, { facts: research?.facts || [] });

      if (check.warnings?.length) {
        log('ScriptAgent', `Uyarı: ${check.warnings.join('; ')}`, 'WARN');
      }

      if (check.ok) {
        // 5. adım: editör geçişi. Düşük puan gelirse bir kez daha yazdırılır.
        const critique = await this.critiqueScript(lastScript, research);
        if (critique && critique.score < CRITIQUE_MIN_SCORE && attempt < MAX_REGEN) {
          lastProblems = critique.issues.length
            ? critique.issues
            : [`editör puanı ${critique.score}/10`];
          log(
            'ScriptAgent',
            `Editör puanı düşük (${critique.score}/10); senaryo yeniden yazılıyor.`,
            'WARN'
          );
          attempt += 1;
          feedback = [critique.hint, ...critique.issues.slice(0, 3)].filter(Boolean).join('; ');
          continue;
        }

        log(
          'ScriptAgent',
          `Senaryo hazır: ${scenes.length} sahne, ${countWords(lastScript.narration)} kelime, ` +
          `~${estimateSeconds(lastScript.narration).toFixed(0)} sn (deneme ${attempt + 1}).`
        );
        return this.finalizeScript(lastScript, topicObj);
      }

      lastProblems = check.problems;
      log(
        'ScriptAgent',
        `Kontrol başarısız (deneme ${attempt + 1}): ${check.problems.slice(0, 5).join('; ')}`,
        'WARN'
      );
      attempt += 1;
      feedback = check.problems.slice(0, 3).join('; ');
    }

    // Son deneme de geçmediyse: sorunlu sahneleri atıp devam et, yeterli değilse dur
    log(
      'ScriptAgent',
      overBudget()
        ? `Senaryo bütçesi doldu (${Math.round(SCRIPT_BUDGET_MS / 60000)} dk); eldeki taslak değerlendiriliyor.`
        : `Senaryo ${MAX_REGEN + 1} denemede kontrolü geçemedi.`,
      'WARN'
    );
    const cleaned = dedupeScenes(sanitizeScenes(lastScript?.scenes || []));
    const words = countWords(cleaned.map((scene) => scene.narration).join(' '));

    // Kural: kusurlu ama izlenebilir bir video, 20 dakika sonra hata vermekten iyidir.
    // En az 6 cümle / 55 kelime varsa uyarılarla devam edilir (video ~25 sn olur).
    const FALLBACK_MIN_SCENES = Number(process.env.SCRIPT_FALLBACK_SCENES || 6);
    const FALLBACK_MIN_WORDS = Number(process.env.SCRIPT_FALLBACK_WORDS || 55);

    if (cleaned.length < FALLBACK_MIN_SCENES || words < FALLBACK_MIN_WORDS) {
      throw new Error(
        `Senaryo üretilemedi (${cleaned.length} cümle, ${words} kelime). ` +
        `Sorunlar: ${lastProblems.slice(0, 4).join('; ')}. ` +
        'Daha büyük model deneyin (LLM_PROVIDER=gemini veya OLLAMA_MODEL=qwen2.5:14b).'
      );
    }

    log(
      'ScriptAgent',
      `Senaryo eksiklerle kabul edildi: ${cleaned.length} cümle, ${words} kelime ` +
      `(${lastProblems.slice(0, 3).join('; ') || 'kontrol uyarısı'}).`,
      'WARN'
    );

    const outline = { title: lastScript?.title || topicObj.topic, description: '', tags: [] };
    return this.finalizeScript(
      this.buildScript(this.prepareScenes(cleaned, topicObj.topic), outline),
      topicObj
    );
  }

  /**
   * 5. adım: render öncesi editör geçişi.
   * Soyut kelime, tekrar, kaynak uyumu ve hook kalitesini puanlar.
   * Model yoksa/başarısızsa null döner; akış durmaz.
   * @returns {Promise<{score:number, issues:string[], hint:string}|null>}
   */
  async critiqueScript(script, research = null) {
    if (process.env.SCRIPT_CRITIQUE === '0') return null;
    const scenes = (script.scenes || []).map((scene, i) =>
      `${i + 1}. ${scene.narration}` +
      (scene.visualObjects?.length ? ` [nesneler: ${scene.visualObjects.join(', ')}]` : '')
    ).join('\n');
    const facts = research?.facts?.length
      ? research.facts.map((fact) => `- ${fact}`).join('\n')
      : '(kaynak yok)';

    try {
      const raw = await this.call([
        'Aşağıdaki Türkçe Shorts senaryosunu editör olarak denetle.',
        '',
        'Senaryo:',
        scenes,
        '',
        'Doğrulanmış kaynak bilgiler:',
        facts,
        '',
        'Şu kusurları ara:',
        '1) Soyut/dolgu kelime (gizemli, ilginç, harika, inanılmaz, şaşırtıcı, muhteşem).',
        '2) Aynı fikrin tekrarı, birbirine benzeyen cümleler.',
        '3) Kaynakta olmayan bilgi (uydurma).',
        '4) İlk cümlenin zayıf hook olması (merak uyandırmıyor).',
        '5) Çizilemeyecek cümle (içinde hiç nesne/yer/kişi geçmiyor).',
        '',
        'Yalnızca JSON döndür:',
        '{"score": 8, "issues": ["1. cümlede \"ilginç\" soyut kelimesi var"],',
        ' "hint": "yeniden yazarken dikkat edilecek tek cümlelik not"}'
      ].join('\n'), { temperature: 0.2, numPredict: 500, label: 'kritik' });

      const score = Number(raw?.score);
      const issues = Array.isArray(raw?.issues)
        ? raw.issues.map((item) => cleanText(item)).filter(Boolean).slice(0, 6)
        : [];
      const hint = cleanText(raw?.hint);
      if (Number.isFinite(score)) {
        log('ScriptAgent', `Editör puanı: ${score}/10${issues.length ? ` (${issues.length} sorun)` : ''}.`);
      }
      return Number.isFinite(score) ? { score, issues, hint } : null;
    } catch (err) {
      log('ScriptAgent', `Editör geçişi atlandı: ${err.message}`, 'WARN');
      return null;
    }
  }

  finalizeScript(script, topicObj) {
    if (!script.title) script.title = cleanText(topicObj.topic);

    const notTurkish =
      /\b(the|and|with|that|this|from|was|were|they|people|which)\b/i.test(script.narration) &&
      !/[ğüşıöç]/i.test(script.narration);
    if (notTurkish) {
      throw new Error('Model Türkçe yerine İngilizce senaryo döndürdü. OLLAMA_MODEL / LLM_PROVIDER ayarını kontrol edin.');
    }

    const labelled = script.labels.filter(Boolean).length;
    log(
      'ScriptAgent',
      `Senaryo: ${script.scenes.length} sahne, ${countWords(script.narration)} kelime, ` +
      `${labelled} bant yazısı, ~${estimateSeconds(script.narration).toFixed(0)} sn.`
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
  minSentenceWords: MIN_SENTENCE_WORDS,
  maxSentenceWords: MAX_SENTENCE_WORDS,
  maxRegen: MAX_REGEN
};
