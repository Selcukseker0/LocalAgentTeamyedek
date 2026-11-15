import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../logger.js';
import { countWords, splitSentences } from '../utils/text.js';

export { splitSentences };
import { askLLM } from '../llm/provider.js';
import { ImageAgent } from './ImageAgent.js';
import { VisionAgent } from './VisionAgent.js';
import { getAudioDuration, resolveBinaries } from '../utils/ffmpeg.js';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WHITEBOARD_DIR = path.resolve(HERE, '../whiteboard');
const RENDER_SCRIPT = path.join(WHITEBOARD_DIR, 'render.py');

const FPS = 30;
const WIDTH = 1080;
// Kare biçimi: jpg (varsayılan, hızlı) veya png (kayıpsız ama ~4 kat yavaş).
// Windows'ta sorun görülürse .env içinde FRAME_FORMAT=png yapılabilir.
const FRAME_FORMAT = process.env.FRAME_FORMAT === 'png' ? 'png' : 'jpg';
const HEIGHT = 1920;

// Sahne kimliği -> Ollama'ya verilecek kısa açıklama
const SCENE_HINTS = {
  egyptian_vase: 'Antik Mısır vazosu / hiyeroglif / tarihî kalıntı',
  honey_pot: 'Bal küpü, süzülen bal',
  milk_bread_honey: 'Süt kutusu, ekmek, bal kavanozu karşılaştırması',
  water_drop: 'Su damlası (nem/su oranı)',
  bacteria_honey: 'Bal içindeki bakteriler / mikroplar',
  question: 'Soru işareti (merak, neden-sonuç)',
  clock: 'Saat (zaman, yıl, süre)',
  sun: 'Güneş (sıcaklık, yaz)',
  heart: 'Kalp (sevgi, sağlık)',
  money: 'Para / banknot (ekonomi, fiyat)',
  house: 'Ev (yuva, konut)',
  book: 'Kitap (bilgi, eğitim)',
  check: 'Onay işareti (doğru, evet)',
  cross: 'Çarpı (yanlış, hayır)',
  bee: 'Arı ve petek (doğa, arıcılık)',
  phone: 'Telefon / uygulama (teknoloji, sosyal medya)',
  chart: 'Yükselen grafik (ekonomi, büyüme, istatistik)',
  shield: 'Kalkan (koruma, güvenlik, sağlık)',
  flame: 'Alev (enerji, sıcaklık, yangın)',
  factory: 'Fabrika (üretim, sanayi, kirlilik)',
  cloud_rain: 'Bulut ve yağmur (hava, iklim, soğuk)',
  sky: 'Gökyüzü, ufuk ve güneş (gündüz, mavi, hava)',
  rainbow: 'Gökkuşağı (renk, ışık, spektrum)',
  planet: 'Gezegen / dünya (uzay, astronomi, yıldız)',
  coffee: 'Kahve fincanı ve çekirdek (kahve, kafein, sabah rutini)',
  lightbulb: 'Ampul (fikir, icat, elektrik, buluş)',
  battery: 'Pil / şarj (enerji, batarya, tükenme)',
  tree: 'Ağaç (doğa, orman, oksijen, çevre)',
  car: 'Araba (ulaşım, yol, trafik, kış)',
  rocket: 'Roket (uzay, fırlatma, hız, keşif)',
  brain: 'Beyin (düşünce, hafıza, öğrenme, zeka)',
  map: 'Harita ve konum iğnesi (yol, seyahat, ülke)',
  thermometer: 'Termometre (sıcaklık, ateş, soğuk, iklim)',
  ice: 'Buz küpü (soğuk, donma, erime, kutup)',
  salt: 'Tuzluk ve dökülen tuz (tuz, deniz, tat)',
  eye: 'Göz (bakış, görme, dikkat)',
  ear: 'Kulak ve ses dalgaları (duyma, ses, gürültü)',
  key: 'Anahtar ve kilit (çözüm, erişim, sır)',
  ladder: 'Merdiven (yükselme, hedef, adım adım)',
  bridge: 'Köprü (bağlantı, iki yaka, geçiş)',
  boat: 'Yelkenli tekne (deniz, yolculuk, ticaret)',
  airplane: 'Uçak (uçuş, seyahat, hız)',
  calendar: 'Takvim (gün, tarih, plan, süre)',
  moon: 'Ay ve yıldızlar (gece, uyku, döngü)',
  magnet: 'Mıknatıs (çekim, manyetizma, etki)',
  leaf: 'Yaprak (bitki, doğa, mevsim)',
  road: 'Yol (hedef, süreç, yolculuk)',
  person: 'Tek insan figürü (biri, kullanıcı, izleyici)',
  two_people: 'İki insan (konuşma, karşılaştırma, topluluk)',
  arrow_up: 'Yukarı ok (artış, iyileşme, yükselme)',
  arrow_down: 'Aşağı ok (azalma, düşüş, kayıp)',
  bubble: 'Konuşma balonu (söylenti, açıklama, iletişim)',
  star: 'Yıldız (hedef, başarı, parlaklık)',
  magnifier: 'Büyüteç (araştırma, inceleme, kanıt)',
  gear: 'Dişli (sistem, mekanizma, ayar)',
  shopping: 'Alışveriş çantası (fiyat, tüketim)',
  generic: 'Konuya uymayan nötr çizim'
};

const SCENE_IDS = Object.keys(SCENE_HINTS);

function log2(message, level = 'INFO') {
  log('WhiteboardVideoAgent', message, level);
}



// ---------------------------------------------------------------- yardımcılar



export function parseSrt(srt) {
  return srt
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .flatMap((block) => {
      const lines = block.split(/\r?\n/);
      const timeIdx = lines.findIndex((l) => l.includes('-->'));
      if (timeIdx < 0) return [];
      const [startRaw, endRaw] = lines[timeIdx].split(/\s+-->\s+/);
      const toSec = (value) => {
        const m = value.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
        if (!m) return null;
        return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
      };
      const start = toSec(startRaw);
      const end = toSec(endRaw);
      const text = lines.slice(timeIdx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
      if (start == null || end == null || !text) return [];
      return [{ start, end, text }];
    });
}

/**
 * Cümleleri ses süresine göre zamanlar. SRT ipuçları cümle sayısıyla
 * eşleşiyorsa gerçek konuşma zamanlaması kullanılır; aksi hâlde süre
 * karakter sayısına göre paylaştırılır.
 */
export function buildTimeline(sentences, cues, audioDuration) {
  if (sentences.length === 0) return [];
  const weight = (text) => countWords(text) + 1;

  if (cues.length === sentences.length) {
    return sentences.map((text, i) => ({
      text,
      start: cues[i].start,
      end: cues[i].end,
      duration: Math.max(1, cues[i].end - cues[i].start)
    }));
  }

  const totalWeight = sentences.reduce((sum, text) => sum + weight(text), 0) || 1;
  let cursor = 0;
  return sentences.map((text) => {
    const duration = Math.max(1, (weight(text) / totalWeight) * audioDuration);
    const item = { text, start: cursor, end: cursor + duration, duration };
    cursor += duration;
    return item;
  });
}

/**
 * Kelime zaman damgalarından cümle sınırlarına oturan zaman çizelgesi.
 * TTS kelime sayısı cümle kelime sayısıyla uyuşmuyorsa null döner.
 */
export function buildTimelineFromWords(sentences, words, audioDuration) {
  if (!Array.isArray(words) || !words.length || !sentences.length) return null;

  const counts = sentences.map((text) => text.split(/\s+/).filter(Boolean).length);
  const textWords = counts.reduce((sum, n) => sum + n, 0);
  if (!textWords) return null;

  const ratio = words.length / textWords;
  if (ratio < 0.75 || ratio > 1.3) return null;

  const timeline = [];
  let cursor = 0;
  for (let i = 0; i < sentences.length; i += 1) {
    const take = Math.max(1, Math.round(counts[i] * ratio));
    const startIndex = Math.min(cursor, words.length - 1);
    const endIndex = Math.min(cursor + take - 1, words.length - 1);
    const start = Number(words[startIndex].start);
    const end = Number(words[endIndex].end);
    timeline.push({
      text: sentences[i],
      start,
      end: Math.max(start + 0.4, end),
      duration: Math.max(0.6, end - start)
    });
    cursor = endIndex + 1;
  }

  // Kalan kelimeler (varsa) son cümleye eklenir; sahne sesin sonuna kadar sürer
  if (timeline.length) {
    const last = timeline[timeline.length - 1];
    last.end = Math.max(last.end, Number(words[words.length - 1].end), audioDuration || 0);
    last.duration = Math.max(0.6, last.end - last.start);
  }
  return timeline;
}

export class WhiteboardVideoAgent {
  constructor() {
    this._python = null;
    this.image = new ImageAgent();
    this.vision = new VisionAgent();
  }

  /**
   * Pillow'un kurulu olduğu Python yorumlayıcısını seçer.
   * Birden fazla Python varsa (Windows mağaza sürümü, venv, python3, ...)
   * önce `import PIL` başarılı olan aday kullanılır.
   */
  async resolvePython() {
    if (this._python) return this._python;
    const candidates = [...new Set(
      [config.pythonBin, 'python3', 'python', 'py'].filter(Boolean)
    )];

    const existing = [];
    for (const bin of candidates) {
      try {
        await execFileAsync(bin, ['--version']);
        existing.push(bin);
      } catch {
        // sıradaki aday
      }
    }

    for (const bin of existing) {
      try {
        await execFileAsync(bin, ['-c', 'import PIL']);
        this._python = bin;
        return bin;
      } catch {
        // bu yorumlayıcıda Pillow yok
      }
    }

    if (existing.length > 0) {
      // Pillow hiçbirinde yok: yine de ilkini döndür, hata mesajı preflight'ta verilir
      log2(`Pillow hiçbir Python yorumlayıcısında bulunamadı (${existing.join(', ')}).`, 'WARN');
      this._python = existing[0];
      return existing[0];
    }
    throw new Error('Python 3 bulunamadı (Pillow gerekli).');
  }

  getAudioDuration(audioPath) {
    return getAudioDuration(audioPath);
  }

  // -------------------------------------------------------------- sahne planı

  async listScenes() {
    try {
      const python = await this.resolvePython();
      const { stdout } = await execFileAsync(python, [RENDER_SCRIPT, '--list-scenes']);
      const parsed = JSON.parse(stdout.trim());
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (err) {
      log2(`Sahne listesi alınamadı, yerleşik liste kullanılıyor: ${err.message}`, 'WARN');
    }
    return SCENE_IDS;
  }

  /** Videoda tekrar eden "konu sahnesi": eşleşmeyen cümlelerde bu kullanılır. */
  pickAnchor(texts, topicText = '') {
    const counts = new Map();
    const add = (text, weight) => {
      const ranked = this.scoreScenes(text);
      ranked.slice(0, 2).forEach((id, i) => {
        counts.set(id, (counts.get(id) || 0) + (i === 0 ? weight : weight * 0.5));
      });
    };

    if (topicText) add(topicText, 3);
    for (const text of texts) add(text, 1);

    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  }

  /** Konu bir sahneyi doyurduğunda aynı görsel aileden devam edilir. */
  static SCENE_FAMILIES = [
    ['nature', ['water_drop', 'sky', 'sun', 'rainbow', 'planet', 'cloud_rain', 'flame', 'bee']],
    ['food', ['honey_pot', 'milk_bread_honey', 'coffee', 'water_drop', 'bacteria_honey', 'bee', 'egyptian_vase']],
    ['science', ['bacteria_honey', 'chart', 'book', 'planet', 'rainbow', 'clock']],
    ['daily', ['house', 'phone', 'money', 'shopping', 'book', 'milk_bread_honey']],
    ['human', ['heart', 'shield', 'clock', 'question']],
    ['industry', ['factory', 'money', 'chart', 'shopping', 'shield', 'check', 'cross']],
    ['tech', ['lightbulb', 'battery', 'phone', 'chart', 'rocket', 'car', 'factory']],
    ['life', ['brain', 'book', 'thermometer', 'heart', 'map', 'tree', 'house']],
    ['travel', ['boat', 'airplane', 'road', 'bridge', 'map', 'car', 'ladder']],
    ['body', ['eye', 'ear', 'brain', 'heart', 'shield', 'hand']],
    ['time', ['clock', 'calendar', 'moon', 'sun', 'hourglass']]
  ];

  /**
   * Her cümle için 1-3 nesnelik çizim kompozisyonu ister.
   * Model yoksa anahtar kelimeden tek nesne üretilir; boş sayfa asla bırakılmaz.
   */
  async planCompositions(timeline, { hints = null, topic = '' } = {}) {
    if (timeline.length === 0) return { compositions: [], sources: [] };

    const available = await this.listScenes();
    const catalog = available
      .map((id) => `- ${id}: ${SCENE_HINTS[id] || 'çizim'}`)
      .join('\n');

    const rows = timeline
      .map((item, i) => {
        const hint = Array.isArray(hints) ? hints[i] : null;
        return `${i + 1}. ${item.text}${hint ? `\n   Çizim tarifi: ${hint}` : ''}`;
      })
      .join('\n');

    let planned = [];
    try {
      const result = await askLLM({
        system: 'Sen bir çizim yönetmenisin. Yalnızca istenen JSON nesnesini döndür.',
        prompt: `Beyaz tahtaya keçeli kalemle çizilecek bir Shorts var.
Her cümle için katalogdan 1-3 nesne seç ve sayfaya yerleştir.
Cümlede anlatılan OLAYI göster: kim/ne, ne yapıyor. Tek kelimeye bakıp nesne seçme.
Aynı nesneyi her cümlede tekrarlama; komşu sahneler birbirinden farklı olsun.
Boş sahne yok: her cümlede en az bir nesne olacak.
Yerleşim: x ve y 0-1 arası (0.5 = sayfanın ortası), size nesnenin alanın ne kadarını
kapladığı (0.25-0.6). Ana nesne büyük, ayrıntılar küçük olsun.

Katalog:
${catalog}

Cümleler:
${rows}

Yalnızca şu JSON biçimini döndür:
{"scenes":[{"index":1,"objects":[{"type":"ice","x":0.42,"y":0.58,"size":0.45},
{"type":"sun","x":0.76,"y":0.26,"size":0.3}]}, ...]}`,
        json: true,
        temperature: 0.2,
        numPredict: 900
      });

      planned = Array.isArray(result?.scenes) ? result.scenes : [];
    } catch (err) {
      log2(`Çizim kompozisyonu alınamadı: ${err.message}`, 'WARN');
    }

    const byIndex = new Map();
    for (const entry of planned) {
      const index = Number(entry?.index ?? entry?.i ?? entry?.sentence);
      if (!Number.isFinite(index)) continue;
      const objects = this.normalizeObjects(entry?.objects ?? entry?.items, available);
      if (objects.length) byIndex.set(index, objects);
    }

    const compositions = [];
    const sources = [];
    let previousKey = '';

    for (let i = 0; i < timeline.length; i += 1) {
      let objects = byIndex.get(i + 1) || null;
      let source = objects ? 'model' : null;

      if (!objects) {
        const hint = Array.isArray(hints) ? hints[i] : '';
        const ranked = this.scoreScenes(`${hint || ''} ${timeline[i].text}`);
        const type = ranked[0] || this.pickAnchor([timeline[i].text], topic) || 'question';
        objects = [{ type, x: 0.5, y: 0.5, size: 0.55 }];
        source = 'anahtar kelime';
      }

      // Arka arkaya aynı çizim olmasın: ana nesneyi aynı aileden başkasıyla değiştir
      const key = objects.map((obj) => obj.type).sort().join('+');
      if (key === previousKey) {
        const primary = objects[0].type;
        const alternative = this.relatedScene(primary, new Map([[primary, 1]]), primary) ||
          (primary === 'question' ? 'book' : 'question');
        if (alternative && alternative !== primary) {
          objects = [{ ...objects[0], type: alternative }, ...objects.slice(1)];
          source = `${source}+çeşitlendirme`;
        }
      }
      previousKey = objects.map((obj) => obj.type).sort().join('+');
      compositions.push(objects);
      sources.push(source);
    }

    const fromModel = sources.filter((item) => item?.startsWith('model')).length;
    log2(`Çizim kompozisyonu: ${fromModel}/${timeline.length} model, ${timeline.length - fromModel} yedek.`);
    return { compositions, sources };
  }

  /** Modelin döndürdüğü nesne listesini güvenli aralıklara çeker. */
  normalizeObjects(raw, available) {
    if (!Array.isArray(raw)) return [];
    const clamp = (value, min, max, fallback) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, number));
    };

    return raw
      .map((obj) => {
        const type = String(obj?.type ?? obj?.id ?? obj?.object ?? '').trim().toLocaleLowerCase('tr');
        if (!available.includes(type)) return null;
        return {
          type,
          x: clamp(obj?.x, 0.16, 0.84, 0.5),
          y: clamp(obj?.y, 0.16, 0.84, 0.5),
          size: clamp(obj?.size ?? obj?.scale, 0.24, 0.62, 0.45)
        };
      })
      .filter(Boolean)
      .slice(0, 3);
  }

  /** Sahne yoksa anahtar kelime eşlemesi (Türkçe ekleri tolere eder). */
  scoreScenes(text) {
    const t = (text || '').toLocaleLowerCase('tr');
    const rules = [
      ['egyptian_vase', ['mısır', 'misir', 'mezar', 'vazo', 'firavun', 'antik', 'hiyeroglif', 'piramit']],
      ['bacteria_honey', ['bakteri', 'mikrop', 'kurut', 'mikroskop', 'virüs', 'virus']],
      ['water_drop', ['su', 'damla', 'nem', 'ıslak', 'islak', 'sulu', 'buz', 'don']],
      ['milk_bread_honey', ['süt', 'sut', 'ekmek', 'bozul', 'gıda', 'gida', 'yemek']],
      ['honey_pot', ['bal', 'reçel', 'tatlı', 'şeker', 'seker', 'arı', 'ari', 'petek']],
      ['clock', ['saat', 'zaman', 'yıl', 'yil', 'süre', 'sure', 'dakika', 'saniye']],
      ['sun', ['güneş', 'gunes', 'sıcak', 'sicak', 'yaz', 'ışın', 'isin', 'parlak']],
      ['sky', ['gökyüzü', 'gokyuzu', 'ufuk', 'gündüz', 'gunduz', 'mavi', 'hava']],
      ['rainbow', ['gökkuşağı', 'gokkusagi', 'renk', 'spektrum', 'ışık', 'isik', 'tayf']],
      ['coffee', ['kahve', 'çekirdek', 'cekirdek', 'fincan', 'bardak', 'kafein', 'barista', 'kavur']],
      ['lightbulb', ['ampul', 'fikir', 'icat', 'buluş', 'bulus', 'lamba', 'elektrik', 'aydınlat']],
      ['battery', ['pil', 'batarya', 'şarj', 'sarj', 'tüken', 'tuken', 'enerji depol']],
      ['tree', ['ağaç', 'agac', 'orman', 'oksijen', 'yaprak', 'kök', 'kok sal', 'fotosentez']],
      ['car', ['araba', 'otomobil', 'trafik', 'sürücü', 'surucu', 'lastik', 'otopark', 'motorlu']],
      ['rocket', ['roket', 'fırlat', 'firlat', 'uçuş', 'ucus', 'keşif', 'kesif', 'yerçekim', 'yercekim']],
      ['brain', ['beyin', 'düşünce', 'dusunce', 'hafıza', 'hafiza', 'öğren', 'ogren', 'zeka', 'unut']],
      ['map', ['harita', 'konum', 'rota', 'seyahat', 'şehir', 'sehir', 'kıta', 'kita', 'ülke', 'ulke']],
      ['thermometer', ['termometre', 'sıcaklık', 'sicaklik', 'derece', 'ateş', 'ates', 'ısı', 'isi', 'soğuk', 'soguk', 'ısın', 'isin']],
      ['ice', ['buz', 'donma', 'donuyor', 'eriyor', 'erime', 'kutup', 'buzul']],
      ['salt', ['tuz', 'tuzlu', 'tuzluluk', 'kristal']],
      ['eye', ['göz', 'goz', 'bakış', 'bakis', 'görme', 'gorme', 'görüyor', 'goruyor', 'dikkat']],
      ['ear', ['kulak', 'duyma', 'duyuyor', 'gürültü', 'gurultu', 'ses dalga', 'dinliyor']],
      ['key', ['anahtar', 'kilit', 'şifre', 'sifre', 'erişim', 'erisim', 'çözüm yolu']],
      ['ladder', ['merdiven', 'tırman', 'tirman', 'yüksel', 'yuksel', 'adım adım', 'adim adim']],
      ['bridge', ['köprü', 'kopru', 'iki yaka', 'bağlantı kur', 'baglanti kur', 'geçiş']],
      ['boat', ['gemi', 'tekne', 'yelken', 'liman', 'okyanus', 'deniz yolu']],
      ['airplane', ['uçak', 'ucak', 'uçuş', 'ucus', 'havayolu', 'pilot', 'havaalan', 'seyahat ediyor']],
      ['calendar', ['takvim', 'tarih', 'hafta', 'her gün', 'her gun', 'ayın', 'ayin']],
      ['moon', ['ay ışı', 'gece', 'uyku', 'dolunay', 'gelgit', 'döngü', 'dongu']],
      ['magnet', ['mıknatıs', 'miknatis', 'manyetik', 'çekim gücü', 'cekim gucu', 'pusula']],
      ['leaf', ['yaprak', 'bitki', 'çiçek', 'cicek', 'mevsim', 'fotosentez', 'yeşil', 'yesil']],
      ['road', ['yol ', 'patika', 'yolculuk', 'süreç', 'surec', 'rota', 'hedefe']],
      ['person', ['insan', 'kişi', 'kisi', 'biri', 'sen ', 'kullanıcı', 'kullanici', 'çocuk', 'cocuk']],
      ['two_people', ['iki kişi', 'iki kisi', 'insanlar', 'topluluk', 'herkes', 'konuşuyor', 'konusuyor']],
      ['arrow_up', ['artıyor', 'artiyor', 'yüksel', 'yuksel', 'çoğal', 'cogal', 'iyileş', 'iyiles', 'güçlen']],
      ['arrow_down', ['azalıyor', 'azaliyor', 'düşüyor', 'dusuyor', 'eriyor', 'tükeniyor', 'tukeniyor', 'kaybol']],
      ['bubble', ['söylüyor', 'soyluyor', 'anlatıyor', 'anlatiyor', 'konuşma', 'konusma', 'söylenti', 'soylenti', 'diyor']],
      ['star', ['başarı', 'basari', 'hedef', 'yıldız', 'yildiz', 'parlak', 'ödül', 'odul']],
      ['magnifier', ['araştır', 'arastir', 'incele', 'kanıt', 'kanit', 'detay', 'gözlem', 'gozlem']],
      ['gear', ['sistem', 'mekanizma', 'makine', 'ayar', 'düzenek', 'duzenek', 'işleyiş', 'isleyis']],
      ['planet', ['gezegen', 'dünya', 'dunya', 'uzay', 'mars', 'yıldız', 'yildiz', 'astronot', 'ay']],
      ['house', ['ev', 'konut', 'kira', 'emlak', 'aile', 'kapı', 'kapi', 'bina', 'oda', 'mutfak']],
      ['check', ['doğru', 'dogru', 'onay', 'çözüm', 'cozum', 'başarı', 'basari']],
      ['cross', ['yanlış', 'yanlis', 'hata', 'risk', 'tehlike', 'zarar', 'yasak']],
      ['heart', ['kalp', 'sevgi', 'sağlık', 'saglik', 'duygu']],
      ['money', ['para', 'fiyat', 'ekonomi', 'zengin', 'maaş', 'maas']],
      ['book', ['kitap', 'okul', 'bilgi', 'öğren', 'ogren', 'eğitim', 'egitim']],
      ['bee', ['çiçek', 'cicek', 'kovan', 'doğa', 'doga']],
      ['phone', ['telefon', 'uygulama', 'internet', 'ekran', 'yapay zeka', 'sosyal medya']],
      ['chart', ['grafik', 'artış', 'artis', 'istatistik', 'büyüme', 'buyume', 'oran', 'ölçüm', 'olcum', 'araştırma', 'arastirma', 'bilim insanı']],
      ['shield', ['koruma', 'güvenlik', 'guvenlik', 'bağışıklık', 'bagisiklik', 'savunma']],
      ['flame', ['ateş', 'ates', 'enerji', 'yangın', 'yangin', 'ısı', 'isi', 'yakıt', 'yakit']],
      ['factory', ['fabrika', 'üretim', 'uretim', 'sanayi', 'kirlilik', 'ihracat']],
      ['cloud_rain', ['yağmur', 'yagmur', 'iklim', 'bulut', 'kuraklık', 'kuraklik', 'fırtına', 'firtina', 'kar', 'soğuk', 'soguk']],
      ['shopping', ['alışveriş', 'alisveris', 'indirim', 'tüketim', 'tuketim', 'market']],
      ['question', ['neden', 'nasıl', 'nasil', 'merak', 'peki']]
    ];

    const scored = rules.map(([id, keywords]) => {
      const score = keywords.reduce((sum, kw) => {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Kısa kelimeler (ev, su, ay...) tam kelime olarak aranır: "evre" ≠ "ev".
        // Uzun kelimelerde Türkçe eklerine izin verilir: "kahvehaneler" = "kahve".
        const pattern = kw.length <= 3
          ? new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, 'iu')
          : new RegExp(`(?<![\\p{L}])${escaped}[\\p{L}]{0,6}(?![\\p{L}])`, 'iu');
        return sum + (pattern.test(t) ? 1 : 0);
      }, 0);
      return { id, score };
    });

    // Soru cümlesi ama somut bir sahne yoksa soru işareti
    const bestOther = Math.max(0, ...scored.filter((s) => s.id !== 'question').map((s) => s.score));
    if (/\?\s*$/.test(t) && bestOther === 0) {
      const q = scored.find((s) => s.id === 'question');
      if (q) q.score = 1;
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.id === 'question' ? 1 : 0) - (b.id === 'question' ? 1 : 0);
    });

    return scored.filter((s) => s.score > 0).map((s) => s.id);
  }

  /** Doymuş sahne için aynı aileden en az kullanılan alternatifi seçer. */
  relatedScene(id, usage, previous = null) {
    const families = WhiteboardVideoAgent.SCENE_FAMILIES;
    const family = families.find(([, list]) => list.includes(id));
    const pool = family ? family[1] : families[3][1];
    const center = pool.indexOf(id);
    const candidates = pool
      .map((candidate, order) => ({ candidate, order }))
      .filter(({ candidate }) => candidate !== previous)
      // Önce aynı ailede anlamca en yakın sahne, sonra az kullanılan
      .sort((a, b) =>
        Math.abs(a.order - center) - Math.abs(b.order - center) ||
        (usage.get(a.candidate) || 0) - (usage.get(b.candidate) || 0)
      )
      .map(({ candidate }) => candidate);
    return candidates.find((candidate) => (usage.get(candidate) || 0) < 2) || candidates[0] || null;
  }

  /** Geriye dönük uyumluluk: en yüksek puanlı sahne. */
  fallbackScene(text, previous = null) {
    const ranked = this.scoreScenes(text);
    if (ranked.length === 0) return 'question';
    if (previous && ranked[0] === previous && ranked.length > 1) return ranked[1];
    return ranked[0];
  }

  // -------------------------------------------------------------- görüntü

  async renderFrames(manifestPath, framesDir, srtPath = null, sheetPath = null) {
    const python = await this.resolvePython();
    log2('Kareler çiziliyor (Pillow)...');
    const args = [RENDER_SCRIPT, '--manifest', manifestPath, '--out', framesDir,
      '--fps', String(FPS), '--size', `${WIDTH}x${HEIGHT}`,
      '--format', FRAME_FORMAT];
    if (srtPath) args.push('--srt', srtPath);
    if (sheetPath) args.push('--sheet', sheetPath);
    const { stdout } = await execFileAsync(python, args, { maxBuffer: 8 * 1024 * 1024 });
    if (stdout.trim()) log2(stdout.trim());
  }

  /** Kısa çalıştırma özeti: hangi sürümün hangi sahneyle üretildiği belli olsun. */
  async writeRunInfo(workDir, data) {
    const infoPath = path.join(workDir, 'run_info.json');
    let commit = 'bilinmiyor';
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: path.resolve(HERE, '../..')
      });
      commit = stdout.trim();
    } catch {
      // git yoksa sorun değil
    }
    const payload = {
      ...data,
      commit,
      fps: FPS,
      size: `${WIDTH}x${HEIGHT}`,
      generatedAt: new Date().toISOString()
    };
    await fs.writeFile(infoPath, JSON.stringify(payload, null, 2), 'utf8');
    return infoPath;
  }

  /** Üretilen mp4 içinde ses akışı var mı? (ffmpeg -i çıktısındaki "Audio:" satırı) */
  async hasAudioStream(videoPath) {
    const { ffmpeg } = await resolveBinaries();
    try {
      await execFileAsync(ffmpeg, ['-i', videoPath], { maxBuffer: 4 * 1024 * 1024 });
      return false;
    } catch (err) {
      return /Stream #\d+:\d+.*Audio:/i.test(String(err?.stderr || ''));
    }
  }

  async encodeVideo({ framesDir, audioPath, outPath, frameCount, ext = FRAME_FORMAT }) {
    const { ffmpeg } = await resolveBinaries();
    const args = [
      '-y',
      '-framerate', String(FPS),
      '-i', path.join(framesDir, `frame_%05d.${ext}`)
    ];
    if (audioPath) args.push('-i', audioPath);

    args.push(
      '-frames:v', String(frameCount),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '19',
      '-threads', '0',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart'
    );
    if (audioPath) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    args.push(outPath);

    await execFileAsync(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 });
  }

  /**
   * Beyaz tahta Shorts üretir.
   * @param {object} opts
   * @param {string|null} opts.audioPath  edge-tts sesi (yoksa sessiz video)
   * @param {string|null} opts.srtPath    altyazı (karelere gömülür)
   * @param {string} opts.narration       senaryo metni (cümlelere bölünür)
   * @param {string} opts.workDir         çalışma klasörü
   * @param {string[]|null} [opts.scenes] hazır sahne kimlikleri (planlamayı atlar)
   */
  /**
   * @param {string|null} [opts.fileName] çıktı dosyası adı (varsayılan: shorts_whiteboard.mp4)
   */
  async renderShorts({ audioPath, srtPath, narration, workDir, scenes = null,
    sceneHints = null, sceneLabels = null, sceneObjects = null, topic = '',
    fileName = 'shorts_whiteboard.mp4', words = null }) {
    // Eski kareler karışmasın: her çalıştırmada klasör sıfırlanır
    const framesDir = path.join(workDir, 'frames');
    await fs.rm(framesDir, { recursive: true, force: true });
    await fs.mkdir(framesDir, { recursive: true });

    const hasAudio = Boolean(audioPath) &&
      (await fs.stat(audioPath).then(() => true).catch(() => false));
    const audioDuration = hasAudio ? await this.getAudioDuration(audioPath) : 0;
    const srtText = srtPath ? await fs.readFile(srtPath, 'utf8').catch(() => '') : '';
    const cues = parseSrt(srtText);

    let duration = audioDuration;
    if (!duration && cues.length) duration = cues[cues.length - 1].end;
    if (!duration) duration = Math.max(4, scenes?.length ? scenes.length * 3 : 12);

    const sentences = splitSentences(narration);

    // 1) tercih: kelime zaman damgaları (Whisper yerine doğrudan TTS'ten)
    let timeline = buildTimelineFromWords(sentences, words, duration || audioDuration);
    let timingSource = 'kelime zamanları';
    // 2) altyazı ipuçları, 3) kelime sayısına göre tahmin
    if (!timeline) {
      timeline = buildTimeline(sentences, cues, duration);
      timingSource = cues.length === sentences.length ? 'altyazı ipuçları' : 'tahmini';
    }
    log2(`Zamanlama kaynağı: ${timingSource} (${sentences.length} cümle).`);

    // 1) Sahne başına üretilmiş illüstrasyon (API varsa)
    const imageJobs = timeline.map((item, i) => ({
      narration: item.text,
      description: (Array.isArray(sceneHints) ? sceneHints[i] : '') || '',
      objects: Array.isArray(sceneObjects) && Array.isArray(sceneObjects[i])
        ? sceneObjects[i]
        : []
    }));
    if (this.image.isEnabled() && this.vision.isEnabled()) {
      log2(this.vision.statusLine());
    } else if (this.image.isEnabled()) {
      log2(this.vision.statusLine(), 'WARN');
    }
    const images = scenes && scenes.length ? scenes.map(() => null)
      : await this.image.generateForScenes(imageJobs, workDir, { vision: this.vision }).catch((err) => {
        log2(`Görsel üretimi atlandı: ${err.message}`, 'WARN');
        return timeline.map(() => null);
      });
    const imageCount = images.filter(Boolean).length;
    const imageRun = this.image.lastRun || {};
    if (imageRun.scores?.filter((score) => Number.isFinite(score)).length) {
      const valid = imageRun.scores.filter((score) => Number.isFinite(score));
      const avg = valid.reduce((sum, score) => sum + score, 0) / valid.length;
      const low = valid.filter((score) => score < 7).length;
      log2(
        `Görsel doğrulama: ortalama ${avg.toFixed(1)}/10` +
        (low ? `, ${low} sahne 7'nin altında` : '') +
        (imageRun.retried ? `, ${imageRun.retried} yeniden deneme` : '')
      );
    }
    if (imageCount) {
      log2(`Görseller kullanılıyor: ${imageCount}/${timeline.length} sahne için üretilmiş illüstrasyon.`);
    } else if (this.image.isEnabled()) {
      log2('Üretilmiş görsel yok; yerleşik çizim kompozisyonlarına dönülüyor.', 'WARN');
    }

    // 2) Görseli olmayan sahneler için 1-3 nesnelik kompozisyon
    let compositions;
    let compositionSources;
    if (scenes && scenes.length) {
      compositions = scenes.map((id) => [{ type: id, x: 0.5, y: 0.5, size: 0.55 }]);
      compositionSources = scenes.map(() => 'elle');
    } else if (imageCount === timeline.length) {
      // Tüm sahneler için illüstrasyon var: kompozisyon planı gerekmez
      compositions = timeline.map(() => null);
      compositionSources = timeline.map(() => 'üretilmiş görsel');
    } else {
      ({ compositions, sources: compositionSources } = await this.planCompositions(
        timeline,
        { hints: sceneHints, topic: topic || narration }
      ));
    }

    const manifest = {
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      scenes: timeline.map((item, i) => ({
        id: (compositions[i]?.[0]?.type) || this.fallbackScene(item.text, null),
        objects: images[i] ? null : (compositions[i] || null),
        image: images[i] || null,
        duration: Math.max(1.2, item.duration),
        text: item.text,
        label: Array.isArray(sceneLabels) && sceneLabels.length === timeline.length
          ? (sceneLabels[i] || null)
          : null
      }))
    };

    const sceneIds = manifest.scenes.map((scene) => scene.id);
    const sceneSources = compositionSources;

    const manifestPath = path.join(workDir, 'whiteboard_manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    log2(
      'Sahne içerikleri: ' +
      manifest.scenes
        .map((scene) => {
          if (scene.image) return `görsel(${path.basename(scene.image)})`;
          return (scene.objects || []).map((obj) => obj.type).join('+') || scene.id;
        })
        .join(' → ')
    );

    const sheetPath = path.join(workDir, 'preview.jpg');
    await this.renderFrames(manifestPath, framesDir, srtPath, sheetPath);
    const frames = (await fs.readdir(framesDir))
      .filter((f) => f.endsWith(`.${FRAME_FORMAT}`))
      .sort();
    if (frames.length === 0) throw new Error('Hiç kare üretilmedi.');

    const finalPath = path.join(workDir, fileName);
    await this.encodeVideo({
      framesDir,
      audioPath: hasAudio ? audioPath : null,
      outPath: finalPath,
      frameCount: frames.length,
      ext: FRAME_FORMAT
    });

    // Ses bekleniyorsa gerçekten videoya girmiş mi kontrol et
    if (hasAudio) {
      const withAudio = await this.hasAudioStream(finalPath);
      if (withAudio) {
        log2(`Ses videoya eklendi (${audioDuration.toFixed(1)}s).`);
      } else {
        log2('UYARI: Ses dosyası verildi ama mp4 içinde ses akışı yok!', 'WARN');
      }
    } else {
      log2('Ses dosyası yok: video sessiz üretildi.', 'WARN');
    }

    const finalDuration = frames.length / FPS;
    const runInfo = await this.writeRunInfo(workDir, {
      topic: topic || null,
      video: path.basename(finalPath),
      scenes: manifest.scenes.map((sc) => sc.id),
      scene_plan: manifest.scenes.map((sc, i) => ({
        index: i + 1,
        text: sc.text,
        scene: sc.id,
        objects: sc.objects || null,
        image: sc.image ? path.basename(sc.image) : null,
        label: sc.label || null,
        source: sceneSources[i] || 'bilinmiyor'
      })),
      timing: timingSource,
      sentences: manifest.scenes.map((sc) => sc.text),
      frameCount: frames.length,
      duration: Number(finalDuration.toFixed(2)),
      audio: hasAudio ? path.basename(audioPath) : null
    });
    log2(`Shorts hazır: ${finalPath} (${finalDuration.toFixed(1)}s, ${frames.length} kare)`);
    log2(`Çalıştırma bilgisi: ${runInfo}`);
    return {
      videoPath: finalPath,
      duration: finalDuration,
      frameCount: frames.length,
      previewPath: sheetPath,
      scenes: manifest.scenes.map((sc) => sc.id)
    };
  }
}

export const WHITEBOARD_SCENES = SCENE_IDS;
