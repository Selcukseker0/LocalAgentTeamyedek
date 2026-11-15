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

/** Konu başlığından en olası maddeyi bulur. */
async function findArticle(host, topic) {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: topic,
    srlimit: '1',
    format: 'json',
    origin: '*'
  });
  const data = await fetchJson(`${host}/w/api.php?${params.toString()}`);
  return data?.query?.search?.[0]?.title || null;
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
    try {
      // 1) Türkçe Wikipedia
      const trTitle = await findArticle(WIKI.tr, clean);
      if (trTitle) {
        const tr = await articleExtract(WIKI.tr, trTitle);
        if (tr.extract) {
          collected.push({
            lang: 'tr',
            title: tr.title,
            url: `${WIKI.tr}/wiki/${encodeURIComponent(tr.title.replace(/\s+/g, '_'))}`,
            text: tr.extract
          });
        }
      }

      // Türkçe madde zayıfsa İngilizce maddeyi de dene
      const short = !collected.length || collected[0].text.length < 400;
      if (short) {
        const query = clean;
        const enTitle = await findArticle(WIKI.en, query).catch(() => null);
        if (enTitle) {
          const en = await articleExtract(WIKI.en, enTitle);
          if (en.extract && en.extract.length > 200) {
            collected.push({
              lang: 'en',
              title: en.title,
              url: `${WIKI.en}/wiki/${encodeURIComponent(en.title.replace(/\s+/g, '_'))}`,
              text: en.extract
            });
          }
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
