import { log } from '../logger.js';
import { askLLM } from '../llm/provider.js';
import { splitSentences } from '../utils/text.js';

// Kaynak havuzu: Türkçe ve İngilizce Wikipedia. Anahtar gerekmez.
const WIKI = {
  tr: 'https://tr.wikipedia.org',
  en: 'https://en.wikipedia.org'
};
const TIMEOUT_MS = 12000;
const MAX_SOURCE_CHARS = 2400;
const TARGET_FACTS = 7;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LocalAgentTeam/1.0 (whiteboard shorts)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const TR_STOPWORDS = new Set([
  'neden', 'niçin', 'nasıl', 'nedir', 'ne', 'mi', 'mı', 'mu', 'mü', 'midir', 'mıdır',
  'kaç', 'hangi', 'kim', 'nerede', 'nereden', 'neden', 'kadar', 'için', 'ile', 've',
  'bir', 'bu', 'şu', 'o', 'çok', 'daha', 'en', 'gibi', 'olan', 'olur', 'oldu', 'var',
  'yok', 'değil', 'mi?', 'soru', 'gerçek', 'aslında', 'hakkında', 'sır', 'sırrı',
  'gizem', 'gizemi', 'hikaye', 'hikayesi'
]);

// Türkçe çekim eklerini kabaca atar: "buzun" -> "buz", "suyun" -> "su",
// "ağırdır" -> "ağır", "piramitleri" -> "piramitler"
const TR_SUFFIXES = [
  'dırlar', 'dirler', 'dur', 'dür', 'dır', 'dir', 'tır', 'tir', 'tur', 'tür',
  'nun', 'nün', 'nin', 'nın', 'lar', 'ler', 'dan', 'den', 'tan', 'ten',
  'un', 'ün', 'ın', 'in', 'da', 'de', 'ta', 'te', 'ya', 'ye', 'yi', 'yı', 'yu', 'yü',
  'a', 'e', 'i', 'ı', 'u', 'ü'
];

export function stemTr(word) {
  let stem = String(word || '').toLocaleLowerCase('tr').trim();
  for (const suffix of TR_SUFFIXES) {
    if (stem.length - suffix.length >= 3 && stem.endsWith(suffix)) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }
  // Kaynaştırma harfi: "suy" -> "su", "arıy" -> "arı"
  if (stem.length >= 3 && stem.endsWith('y') && /[aeıioöuü]/.test(stem.charAt(stem.length - 2))) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

/** Metni gövdelenmiş kelime kümesine çevirir ("balık" ≠ "bal"). */
function stemSet(text) {
  return new Set(
    String(text || '')
      .toLocaleLowerCase('tr')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1)
      .map((word) => stemTr(word))
      .filter((word) => word.length >= 2)
  );
}

/** Konudan Wikipedia araması için anahtar kelimeler (soru/süs kelimeleri atılır). */
export function topicKeywords(topic) {
  return [...new Set(
    String(topic || '')
      .toLocaleLowerCase('tr')
      .replace(/[?!.:;,]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1 && !TR_STOPWORDS.has(word))
      .map((word) => stemTr(word))
      .filter((word) => word.length >= 2)
  )];
}

export function buildSearchQuery(topic) {
  const keywords = topicKeywords(topic);
  return keywords.slice(0, 4).join(' ') || String(topic || '').trim();
}

/**
 * Madde/özet konuyla gerçekten ilgili mi? 0-1 arası örtüşme puanı.
 * Kelime gövdeleri karşılaştırılır: "bal" ile "balık" eşleşmez (yanlış madde riski).
 */
export function relevanceScore(topic, text) {
  const keywords = topicKeywords(topic);
  if (!keywords.length) return 0;
  const stems = stemSet(text);
  const hits = keywords.filter((keyword) => stems.has(keyword));
  return hits.length / keywords.length;
}

/**
 * Arama sonuçlarından konuya en uygun maddeyi seçer.
 * İlk sonucu körlemesine almak tehlikeli: "Buzun sırrı ne?" sorgusu
 * "Mehmed Selim Sırrı Paşa" maddesine gidebiliyor (kelime tesadüfü).
 * Kural: konunun ANA kelimesi (ilk anahtar) başlıkta/özet parçasında geçmeli.
 */
export function pickBestArticle(topic, candidates, minScore = 0.34) {
  const keywords = topicKeywords(topic);
  const primary = keywords[0] || '';
  let best = null;
  for (const candidate of candidates || []) {
    const title = String(candidate.title || '');
    const haystack = `${title} ${candidate.snippet || ''}`;
    const titleStems = stemSet(title);
    const primaryHit = primary ? stemSet(haystack).has(primary) : false;
    const score = relevanceScore(topic, haystack);
    // Ana kelime başlıkta geçiyorsa ekstra güven
    const total = score + (primary && titleStems.has(primary) ? 0.15 : 0);
    if (!primaryHit) continue;
    if (total < minScore) continue;
    if (!best || total > best.score) best = { ...candidate, score: total };
  }
  return best;
}

/** Wikipedia aramasında ilk N adayı özetiyle döner. */
async function findCandidates(host, query, limit = 5) {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(limit),
    srprop: 'snippet',
    format: 'json',
    origin: '*'
  });
  const data = await fetchJson(`${host}/w/api.php?${params.toString()}`);
  return (data?.query?.search || []).map((item) => ({
    title: item.title,
    snippet: String(item.snippet || '').replace(/<[^>]+>/g, ' ')
  }));
}

/** Konuyla ilgili maddeyi seçer; ilgisizse null (yanlış bilgi yazmaktansa hiç yazmamak iyidir). */
async function findArticle(host, topic) {
  const query = buildSearchQuery(topic);
  const minScore = Number(process.env.RESEARCH_MIN_MATCH || 0.34);
  const candidates = await findCandidates(host, query);
  const best = pickBestArticle(topic, candidates, minScore);
  if (best) {
    log('ResearchAgent', `Madde eşleşti: "${best.title}" (uygunluk ${(best.score * 100).toFixed(0)}%)`);
    return best.title;
  }
  if (candidates.length) {
    log(
      'ResearchAgent',
      `Konuyla ilgili madde yok; en yakın sonuç "${candidates[0].title}" yeterince alakalı değil.`,
      'WARN'
    );
  }
  return null;
}

/** Maddenin düz metin özetini çeker (ilk N cümle). */
async function articleExtract(host, title, sentences = 12) {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'extracts',
    explaintext: '1',
    exsentences: String(sentences),
    titles: title,
    format: 'json',
    origin: '*',
    redirects: '1'
  });
  const data = await fetchJson(`${host}/w/api.php?${params.toString()}`);
  const pages = data?.query?.pages || {};
  const page = Object.values(pages)[0] || {};
  return {
    title: page.title || title,
    extract: String(page.extract || '').replace(/\s+/g, ' ').trim()
  };
}

/** Bir cümlede somut veri var mı? (sayı, yıl, yüzde, özel isim) */
function looksConcrete(sentence) {
  if (/\d/.test(sentence)) return true;
  const words = sentence.split(/\s+/);
  return words.slice(1).some((word) => /^[A-ZÇĞİÖŞÜ][a-zçğıöşü]{2,}/.test(word));
}

function normalize(text) {
  return String(text || '').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim();
}

function tokenSet(text) {
  return new Set(
    normalize(text)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3)
  );
}

/** Modelin uydurduğu bilgiyi ayıklar: kaynak metinde geçmeyen cümle kabul edilmez. */
function groundedInSource(fact, sourceTokens) {
  const tokens = tokenSet(fact);
  if (!tokens.size) return false;
  let hits = 0;
  for (const token of tokens) if (sourceTokens.has(token)) hits += 1;
  return hits / tokens.size >= 0.3;
}

/**
 * Kaynak metinden somut, doğrulanabilir olgular çıkarır.
 * Model kullanılamazsa cümle seçme yedeği devreye girer.
 */
export async function extractFacts(source, topic = '', limit = TARGET_FACTS) {
  const text = String(source || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const sourceTokens = tokenSet(text);

  try {
    const raw = await askLLM({
      system:
        'Sen bir araştırma editörüsün. SADECE verilen metindeki bilgileri kullanırsın. ' +
        'Metinde olmayan hiçbir şeyi yazmazsın. Yalnızca JSON döndür.',
      prompt: [
        `Konu: "${topic}"`,
        '',
        'Aşağıdaki kaynak metinden 6-8 SOMUT olgu çıkar.',
        'Kurallar:',
        '- Her olgu TEK bilgi içersin: sayı, yıl, yer, isim veya neden-sonuç.',
        '- Olgu 8-20 kelime olsun, tam cümle olsun.',
        '- Metinde geçmeyen bilgiyi YAZMA (tahmin, genel kültür, yorum yok).',
        '- Soyut ifade yok: "ilginç", "gizemli", "şaşırtıcı" gibi kelimeler kullanma.',
        '',
        'Kaynak metin:',
        text.slice(0, MAX_SOURCE_CHARS),
        '',
        'Yalnızca şu JSON biçimini döndür:',
        '{"facts":["...","..."]}'
      ].join('\n'),
      json: true,
      temperature: 0.2,
      numPredict: 700
    });

    const rawFacts = Array.isArray(raw?.facts) ? raw.facts : [];
    const facts = [];
    let dropped = 0;
    for (const item of rawFacts) {
      const fact = String(item || '').replace(/\s+/g, ' ').trim();
      const words = fact.split(' ').filter(Boolean).length;
      if (words < 5 || words > 26) continue;
      if (!groundedInSource(fact, sourceTokens)) {
        dropped += 1;
        continue;
      }
      if (facts.some((other) => normalize(other) === normalize(fact))) continue;
      facts.push(/[.!?]$/.test(fact) ? fact : `${fact}.`);
      if (facts.length >= limit) break;
    }
    if (facts.length >= 3) {
      log(
        'ResearchAgent',
        `Kaynaktan ${facts.length} olgu çıkarıldı${dropped ? `, ${dropped} uydurma elendi` : ''}.`
      );
      return facts;
    }
    if (dropped) log('ResearchAgent', `${dropped} olgu kaynakta bulunmadığı için elendi.`, 'WARN');
  } catch (err) {
    log('ResearchAgent', `Olgu çıkarma modeli kullanılamadı (${err.message}); cümlelerden seçiliyor.`, 'WARN');
  }

  // Yedek: kaynaktaki somut cümleleri seç
  return splitSentences(text)
    .filter((sentence) => {
      const words = sentence.split(' ').filter(Boolean).length;
      return words >= 6 && words <= 26 && looksConcrete(sentence);
    })
    .slice(0, limit);
}

/**
 * Konu hakkında kaynak metin ve doğrulanabilir olgular toplar.
 * Ağ yoksa boş sonuç döner; senaryo bilgi olmadan da yazılabilir.
 */
export class ResearchAgent {
  /** @returns {Promise<{summary:string,title:string,source:string,facts:string[],sources:Array}>} */
  async research(topic) {
    const clean = String(topic || '').trim();
    const empty = { summary: '', title: '', source: '', facts: [], sources: [] };
    if (!clean) return empty;

    if (process.env.RESEARCH_ENABLED === '0') {
      log('ResearchAgent', 'Araştırma kapalı (RESEARCH_ENABLED=0).');
      return empty;
    }

    const collected = [];
    const minScore = Number(process.env.RESEARCH_MIN_MATCH || 0.34);

    // Özet de konuyla örtüşüyor mu? (madde doğru başlıkta ama yanlış konuda olabilir)
    const accept = (lang, host, page) => {
      const haystack = `${page.title} ${page.extract.slice(0, 800)}`;
      const score = relevanceScore(clean, haystack);
      if (score < minScore) {
        log(
          'ResearchAgent',
          `"${page.title}" maddesi konuyla örtüşmüyor (%${(score * 100).toFixed(0)}); atlandı.`,
          'WARN'
        );
        return;
      }
      collected.push({
        lang,
        title: page.title,
        url: `${host}/wiki/${encodeURIComponent(page.title.replace(/\s+/g, '_'))}`,
        text: page.extract
      });
    };

    try {
      // 1) Türkçe Wikipedia
      const trTitle = await findArticle(WIKI.tr, clean);
      if (trTitle) {
        const tr = await articleExtract(WIKI.tr, trTitle);
        if (tr.extract) accept('tr', WIKI.tr, tr);
      }

      // Türkçe madde zayıfsa İngilizce maddeyi de dene
      const short = !collected.length || collected[0].text.length < 400;
      if (short) {
        const enTitle = await findArticle(WIKI.en, clean).catch(() => null);
        if (enTitle) {
          const en = await articleExtract(WIKI.en, enTitle);
          if (en.extract && en.extract.length > 200) accept('en', WIKI.en, en);
        }
      }
    } catch (err) {
      log('ResearchAgent', `Araştırma yapılamadı (${err.message}); senaryo bilgi olmadan yazılacak.`, 'WARN');
      return empty;
    }

    if (!collected.length) {
      log('ResearchAgent', 'Wikipedia maddesi bulunamadı, araştırma atlandı.', 'WARN');
      return { ...empty, sources: [] };
    }

    const summary = collected
      .map((item) => `[${item.lang.toUpperCase()} · ${item.title}]\n${item.text}`)
      .join('\n\n')
      .slice(0, MAX_SOURCE_CHARS);

    // Türkçe kaynak yoksa İngilizce metinden olgu çıkarken Türkçeye çevirmesi istenir.
    const facts = await extractFacts(summary, clean);

    log(
      'ResearchAgent',
      `Araştırma: ${collected.length} kaynak, ${summary.length} karakter, ${facts.length} olgu.`
    );

    return {
      summary,
      title: collected[0].title,
      source: collected[0].url,
      facts,
      sources: collected.map((item) => ({ lang: item.lang, title: item.title, url: item.url }))
    };
  }
}
