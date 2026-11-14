import { XMLParser } from 'fast-xml-parser';
import { askOllama } from '../llm/ollamaClient.js';
import { storage } from '../storage.js';
import { log } from '../logger.js';

const RSS_SOURCES = [
  {
    category: 'gündem',
    url: 'https://trends.google.com/trending/rss?geo=TR'
  },
  {
    category: 'bilim-teknoloji',
    url: 'https://feeds.bbci.co.uk/turkce/rss.xml'
  },
  {
    category: 'ilginç bilgiler',
    url: 'https://www.reddit.com/r/todayilearned/top/.rss?t=day'
  }
];

const CATEGORIES = [
  'teknoloji',
  'tarih',
  'ilginç bilgiler',
  'gizem',
  'bilim',
  'eğlence',
  'gündem'
];

export class TrendAgent {

  async fetchCandidates() {
    const parser = new XMLParser({
      ignoreAttributes: false,
      processEntities: false
    });

    const items = [];

    for (const source of RSS_SOURCES) {
      try {
        const res = await fetch(source.url, {
          headers: { 'User-Agent': 'LocalAgentTeam/1.0' }
        });

        if (!res.ok) continue;

        const xml = await res.text();
        const parsed = parser.parse(xml);

        const feedItems =
          parsed?.rss?.channel?.item ||
          parsed?.feed?.entry ||
          [];

        const list = Array.isArray(feedItems) ? feedItems : [feedItems];

        for (const entry of list.slice(0, 8)) {
          const rawTitle = typeof entry.title === 'object'
            ? entry.title['#text']
            : entry.title;

          if (rawTitle) {
            items.push({
              sourceCategory: source.category,
              title: String(rawTitle).trim()
            });
          }
        }
      } catch (err) {
        log('TrendAgent', `RSS okunamadı (${source.url}): ${err.message}`, 'WARN');
      }
    }

    log('TrendAgent', `Toplam ${items.length} aday başlık toplandı.`);
    return items;
  }

  async pickDailyTopic() {
    const candidates = await this.fetchCandidates();
    const usedTopics = await storage.getUsedTopics();

    const candidateList = candidates
      .map((item, idx) => {
        return `${idx + 1}. [${item.sourceCategory}] ${item.title}`;
      })
      .join('\n');

    const usedList = usedTopics.slice(-60).join(', ') || 'Yok';

    const prompt = [
      `Kategorilerimiz: ${CATEGORIES.join(', ')}`,
      '',
      'Güncel aday başlıklar (bunlardan seçebilir veya bu kategorilerden çok ilgi çekici özgün bir konu belirleyebilirsin):',
      candidateList,
      '',
      'DAHA ÖNCE İŞLENEN KONULAR (BUNLARI KESİNLİKLE TEKRAR SEÇME):',
      usedList,
      '',
      'YouTube Shorts\'ta izlenme potansiyeli en yüksek TEK bir konu seç ve popülerlik puanı ver.',
      'Sadece şu JSON formatında yanıt ver:',
      '{',
      '  "topic": "Seçilen konu başlığı",',
      '  "category": "kategori adı",',
      '  "popularityScore": 1-100 arası sayı,',
      '  "reason": "Seçim nedeni"',
      '}'
    ].join('\n');

    const result = await askOllama({
      system: 'Sen viral YouTube Shorts içerik araştırmacısısın. Sadece JSON döndür.',
      prompt,
      json: true,
      temperature: 0.8
    });

    log(
      'TrendAgent',
      `Konu seçildi: "${result.topic}" [${result.category}] Puan: ${result.popularityScore}`
    );

    return result;
  }
}