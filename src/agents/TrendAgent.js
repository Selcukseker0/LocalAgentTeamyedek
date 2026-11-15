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

// Ollama/RSS olmadığında da tekrar etmeyen, çizilebilir "ilginç bilgi" konuları
const EVERGREEN_TOPICS = [
  { topic: 'Uzayda neden ses duyulmaz?', category: 'bilim' },
  { topic: 'Karıncalar kendi ağırlıklarının kaç katını taşır?', category: 'ilginç bilgiler' },
  { topic: 'Neden esneriz ve esnemek bulaşıcı mıdır?', category: 'bilim' },
  { topic: 'Osmanlı ordusu neden Mehter marşıyla yürürdü?', category: 'tarih' },
  { topic: 'Kahve dünyayı nasıl değiştirdi?', category: 'tarih' },
  { topic: 'Buz neden kaygandır?', category: 'bilim' },
  { topic: 'İnsan beyni günde kaç düşünce üretir?', category: 'bilim' },
  { topic: 'Neden uçağımızın penceresi yuvarlak?', category: 'teknoloji' },
  { topic: 'Deniz suyu neden tuzludur?', category: 'bilim' },
  { topic: 'Gökyüzü neden mavidir?', category: 'bilim' },
  { topic: 'Mısır piramitleri nasıl inşa edildi?', category: 'tarih' },
  { topic: 'Neden bazı insanlar sivrisinekleri çeker?', category: 'ilginç bilgiler' },
  { topic: 'Bir gün gerçekten 24 saat mi?', category: 'bilim' },
  { topic: 'Neden rüya görürüz?', category: 'bilim' },
  { topic: 'Dünyanın en derin çukuru nerede?', category: 'gizem' },
  { topic: 'Neden yaşlanırız?', category: 'bilim' },
  { topic: 'Elektrikli araç bataryası neden yavaş şarj olur?', category: 'teknoloji' },
  { topic: 'Neden bazı yemekler acıdır?', category: 'ilginç bilgiler' },
  { topic: 'İstanbul fethinde hangi teknoloji kullanıldı?', category: 'tarih' },
  { topic: 'Neden aynada kendimizi tanırız?', category: 'bilim' },
  { topic: 'Deniz fenerleri gemilere nasıl yol gösterir?', category: 'teknoloji' },
  { topic: 'Neden kediler kutulara girer?', category: 'ilginç bilgiler' },
  { topic: 'Atlantik Okyanusu neden genişliyor?', category: 'bilim' },
  { topic: 'Neden limon suyu yaraya acıtır?', category: 'ilginç bilgiler' },
  { topic: 'Para nasıl icat edildi?', category: 'tarih' },
  { topic: 'Neden bazı geceler yıldızlar daha parlak?', category: 'gizem' }
];

// İngilizce başlıklar (Reddit/TIL) olduğu gibi konu seçilmesin
const ENGLISH_HINTS = /\b(the|that|this|was|were|and|with|from|people|about|when|they|which|after|before|over|into|his|her|their|until|ended|secret|story|stories|world|life|lives|king|queen|famous|history|hidden|truth|reason|power|money|game|night|party|hotel|death|murder|gold|war|love|best|worst|weird|strange|city|food|water|sleep|dream|man|woman|body|brain|human|science|space|earth|animal|stone|ship|plane|car|house|school|doctor|music|movie|film|singer|actor|president|army|soldier|balloon|jumping|lethal|accidents|trend|fad|popular|ancient|roman|greek|daily|first|last|great)\b/i;

// Türkçe soru/kip işaretleri: konu Türkçe yazılmamışsa burada da eşleşmez
const TURKISH_MARKERS = /\b(neden|nasıl|niçin|hangi|kaç|kim|nerede|midir|mıdır|mudur|müdür|gerçek|sır|sırrı|hikaye|hikayesi|tarihi|aslında)\b/i;

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

  normalize(topic) {
    return String(topic || '')
      .toLocaleLowerCase('tr')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  isUsed(topic, usedTopics) {
    const target = this.normalize(topic);
    if (!target) return true;
    return usedTopics.some((used) => {
      const other = this.normalize(used);
      if (!other) return false;
      return other === target || other.includes(target) || target.includes(other);
    });
  }

  /**
   * Konu Türkçe ve kısa mı? (İngilizce TIL başlıkları, çok uzun cümleler reddedilir.)
   */
  isTurkishTopic(topic) {
    const text = String(topic || '').trim();
    if (text.length < 12 || text.length > 90) return false;
    if (text.split(/\s+/).length > 14) return false;

    const hasTurkishChars = /[ğüşıöç]/i.test(text);
    const hasTurkishMarker = TURKISH_MARKERS.test(text);
    const hasEnglish = ENGLISH_HINTS.test(text);

    // Hiç Türkçe karakter ve Türkçe kalıp yoksa ("Elvis'in Las Vegas secret") reddet
    if (!hasTurkishChars && !hasTurkishMarker) return false;
    // İngilizce kelime + Türkçe karakter yoksa reddet
    if (hasEnglish && !hasTurkishChars) return false;
    // İngilizce kelimeyle karışmış başlık ("... Las Vegas secret") reddet
    if (hasEnglish && hasTurkishChars) return false;

    return true;
  }

  /** Her durumda çalışan yedek: geçmişte işlenmemiş ilginç konu seçer. */
  pickEvergreen(usedTopics, recentCategories = []) {
    const fresh = EVERGREEN_TOPICS.filter((item) => !this.isUsed(item.topic, usedTopics));
    const pool = fresh.length ? fresh : EVERGREEN_TOPICS;
    const notRecent = pool.filter((item) => !recentCategories.includes(item.category));
    const choices = notRecent.length ? notRecent : pool;
    const picked = choices[Math.floor(Math.random() * choices.length)];
    return {
      topic: picked.topic,
      category: picked.category,
      popularityScore: 70,
      reason: 'Yedek konu listesinden seçildi (tekrar etmeyen ilginç bilgi).',
      source: 'evergreen'
    };
  }

  async pickDailyTopic() {
    const candidates = await this.fetchCandidates();
    const usedTopics = await storage.getUsedTopics();
    const recentCategories = await storage.getRecentCategories(6);

    const candidateList = candidates
      .map((item, idx) => {
        return `${idx + 1}. [${item.sourceCategory}] ${item.title}`;
      })
      .join('\n');

    const usedList = usedTopics.slice(-60).join(', ') || 'Yok';

    const buildPrompt = (strict) => [
      `Kategorilerimiz: ${CATEGORIES.join(', ')}`,
      '',
      'Güncel aday başlıklar (bunlardan seçebilir veya bu kategorilerden çok ilgi çekici özgün bir konu belirleyebilirsin):',
      candidateList || '(kaynak bulunamadı)',
      '',
      'DAHA ÖNCE İŞLENEN KONULAR (BUNLARI KESİNLİKLE TEKRAR SEÇME, benzerini de seçme):',
      usedList,
      '',
      `SON KULLANILAN KATEGORİLER (mümkünse farklı bir kategori seç): ${recentCategories.join(', ') || 'Yok'}`,
      '',
      'Kurallar:',
      '- "topic" alanı TÜRKÇE olacak. İngilizce başlığı olduğu gibi kopyalama; Türkçeye çevirip kısalt.',
      '- "topic" en fazla 8 kelime ve 70 karakter olsun; sonunda nokta olmasın.',
      '- Konu beyaz tahtaya keçeli kalemle somut nesneler çizilerek anlatılabilir olmalı.',
      '- Az bilinen, şaşırtıcı bir bilgi içermeli; "neden/nasıl" sorusuna cevap vermeli.',
      '- 45-50 saniyelik videoya sığacak tek bir odak konusu seç.',
      strict ? '- Önceki cevabın uygun değildi (tekrar/İngilizce/çok uzun). TAMAMEN farklı, TÜRKÇE, kısa bir konu seç.' : '',
      '',
      'Sadece şu JSON formatında yanıt ver:',
      '{',
      '  "topic": "Seçilen konu başlığı",',
      '  "category": "kategori adı",',
      '  "popularityScore": 1-100 arası sayı,',
      '  "reason": "Seçim nedeni"',
      '}'
    ].filter(Boolean).join('\n');

    const system = 'Sen viral YouTube Shorts içerik araştırmacısısın. Sadece JSON döndür.';

    let result = null;
    for (const strict of [false, true]) {
      try {
        const candidate = await askOllama({
          system,
          prompt: buildPrompt(strict),
          json: true,
          temperature: strict ? 1.0 : 0.85
        });
        if (!candidate?.topic) continue;
        if (!this.isTurkishTopic(candidate.topic)) {
          log('TrendAgent', `Konu Türkçe/kısa değil, reddedildi: "${candidate.topic}"`, 'WARN');
          continue;
        }
        if (this.isUsed(candidate.topic, usedTopics)) {
          log('TrendAgent', `Tekrar eden konu reddedildi: "${candidate.topic}"`, 'WARN');
          continue;
        }
        result = candidate;
        break;
      } catch (err) {
        log('TrendAgent', `Ollama konu seçemedi: ${err.message}`, 'WARN');
        break;
      }
    }

    if (!result) {
      result = this.pickEvergreen(usedTopics, recentCategories);
      log('TrendAgent', 'Yedek konu listesi kullanıldı.', 'WARN');
    }

    result.source = result.source || 'ollama';
    await storage.reserveTopic(result.topic, result.category);

    log(
      'TrendAgent',
      `Konu seçildi: "${result.topic}" [${result.category}] ` +
      `Puan: ${result.popularityScore} (${result.source})`
    );

    return result;
  }
}