import { log } from '../logger.js';

const TR_WIKI_API = 'https://tr.wikipedia.org/w/api.php';
const TR_WIKI_SUMMARY = 'https://tr.wikipedia.org/api/rest_v1/page/summary';
const TIMEOUT_MS = 12000;

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

/** Konu başlığından en olası Wikipedia maddesini bulur. */
async function findArticle(topic) {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: topic,
    srlimit: '1',
    format: 'json',
    origin: '*'
  });
  const data = await fetchJson(`${TR_WIKI_API}?${params.toString()}`);
  const hit = data?.query?.search?.[0];
  return hit?.title || null;
}

/**
 * Konu hakkında kısa, doğrulanmış bilgi toplar.
 * Ağ yoksa veya madde bulunamazsa boş sonuç döner; senaryo yine yazılır.
 */
export class ResearchAgent {
  async research(topic) {
    const clean = String(topic || '').trim();
    if (!clean) return { summary: '', title: '', source: '', facts: [] };

    try {
      const article = await findArticle(clean);
      if (!article) {
        log('ResearchAgent', 'Wikipedia maddesi bulunamadı, araştırma atlandı.', 'WARN');
        return { summary: '', title: '', source: '', facts: [] };
      }

      const encoded = encodeURIComponent(article.replace(/\s+/g, '_'));
      const summary = await fetchJson(`${TR_WIKI_SUMMARY}/${encoded}`);
      const extract = String(summary?.extract || '').replace(/\s+/g, ' ').trim();
      if (!extract) {
        return { summary: '', title: article, source: '', facts: [] };
      }

      // Uzun özeti cümlelere bölüp ilk birkaçını "bilgi" olarak ver
      const sentences = extract
        .split(/(?<=[.!?])\s+/)
        .map((item) => item.trim())
        .filter((item) => item.split(/\s+/).length >= 5)
        .slice(0, 5);

      log('ResearchAgent', `Araştırma: "${article}" (${extract.length} karakter).`);

      return {
        summary: extract.slice(0, 1200),
        title: article,
        source: summary?.content_urls?.desktop?.page || '',
        facts: sentences
      };
    } catch (err) {
      log('ResearchAgent', `Araştırma yapılamadı (${err.message}); senaryo bilgi olmadan yazılacak.`, 'WARN');
      return { summary: '', title: '', source: '', facts: [] };
    }
  }
}
