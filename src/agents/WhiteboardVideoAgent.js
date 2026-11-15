import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../logger.js';
import { askOllama } from '../llm/ollamaClient.js';
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
  shopping: 'Alışveriş çantası (fiyat, tüketim)',
  generic: 'Konuya uymayan nötr çizim'
};

const SCENE_IDS = Object.keys(SCENE_HINTS);

function log2(message, level = 'INFO') {
  log('WhiteboardVideoAgent', message, level);
}

// ---------------------------------------------------------------- yardımcılar

export function splitSentences(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  // Türkçe kısaltmalar (vb., vs., Dr.) cümle sonu sayılmasın
  const protectedText = clean.replace(/\b(vb|vs|Dr|Prof|No|ör)\./gi, (m) => m.replace('.', '\u0001'));
  return protectedText
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.replace(/\u0001/g, '.').trim())
    .filter(Boolean);
}

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
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0) || 1;

  if (cues.length === sentences.length) {
    return sentences.map((text, i) => ({
      text,
      start: cues[i].start,
      end: cues[i].end,
      duration: Math.max(1, cues[i].end - cues[i].start)
    }));
  }

  let cursor = 0;
  return sentences.map((text) => {
    const duration = Math.max(1, (text.length / totalChars) * audioDuration);
    const item = { text, start: cursor, end: cursor + duration, duration };
    cursor += duration;
    return item;
  });
}

export class WhiteboardVideoAgent {
  constructor() {
    this._python = null;
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

  /** Ollama ile her cümleye beyaz tahta sahnesi atar (başarısızsa anahtar kelime). */
  async planScenes(timeline, availableScenes = SCENE_IDS) {
    if (timeline.length === 0) return [];
    const catalog = availableScenes
      .map((id) => `- ${id}: ${SCENE_HINTS[id] || 'serbest çizim'}`)
      .join('\n');

    try {
      const result = await askOllama({
        system: 'Sen bir çizim yönetmenisin. Yalnızca istenen JSON nesnesini döndür.',
        prompt: `Elimde beyaz tahtaya keçeli kalemle çizilecek bir Shorts anlatımı var.
Her cümle için en uygun sahneyi seç. Cümle sırasını koru, sahne sayısı cümle sayısına eşit olsun.
Katalog:\n${catalog}

Cümleler:
${timeline.map((item, i) => `${i + 1}. ${item.text}`).join('\n')}

Yalnızca şu JSON biçimini döndür:
{"scenes":[{"index":1,"scene":"<katalogdaki kimlik>"}, ...]}`,
        json: true,
        temperature: 0.1
      });

      const planned = Array.isArray(result?.scenes) ? result.scenes : [];
      const byIndex = new Map(
        planned
          .filter((p) => availableScenes.includes(p?.scene))
          .map((p) => [Number(p.index), p.scene])
      );
      if (byIndex.size >= Math.ceil(timeline.length / 2)) {
        return timeline.map((_item, i) => byIndex.get(i + 1) || null);
      }
    } catch (err) {
      log2(`Ollama sahne planı alınamadı: ${err.message}`, 'WARN');
    }
    return timeline.map(() => null);
  }

  /** Konu bir sahneyi doyurduğunda aynı görsel aileden devam edilir. */
  static SCENE_FAMILIES = [
    ['nature', ['water_drop', 'sky', 'sun', 'rainbow', 'planet', 'cloud_rain', 'flame', 'bee']],
    ['food', ['honey_pot', 'milk_bread_honey', 'coffee', 'water_drop', 'bacteria_honey', 'bee', 'egyptian_vase']],
    ['science', ['bacteria_honey', 'chart', 'book', 'planet', 'rainbow', 'clock']],
    ['daily', ['house', 'phone', 'money', 'shopping', 'book', 'milk_bread_honey']],
    ['human', ['heart', 'shield', 'clock', 'question']],
    ['industry', ['factory', 'money', 'chart', 'shopping', 'shield', 'check', 'cross']]
  ];

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
      ['coffee', ['kahve', 'çekirdek', 'cekirdek', 'fincan', 'bardak', 'kafein', 'barista', 'koku', 'sabah', 'kavur']],
      ['planet', ['gezegen', 'dünya', 'dunya', 'uzay', 'mars', 'yıldız', 'yildiz', 'astronot', 'ay']],
      ['house', ['ev', 'konut', 'kira', 'emlak', 'aile', 'kapı', 'kapi', 'araba', 'bina', 'oda', 'mutfak']],
      ['check', ['doğru', 'dogru', 'tamam', 'onay', 'çözüm', 'cozum', 'başarı', 'basari']],
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
        const pattern = new RegExp(`(?<![\\p{L}])${escaped}`, 'iu');
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
    const candidates = pool
      .filter((candidate) => candidate !== previous)
      .sort((a, b) => (usage.get(a) || 0) - (usage.get(b) || 0));
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
    sceneHints = null, fileName = 'shorts_whiteboard.mp4' }) {
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
    const timeline = buildTimeline(sentences, cues, duration);

    let sceneIds;
    if (Array.isArray(scenes) && scenes.length) {
      sceneIds = scenes;
    } else {
      const available = await this.listScenes();
      const planned = await this.planScenes(timeline, available);
      const hints = Array.isArray(sceneHints) && sceneHints.length === timeline.length
        ? sceneHints
        : null;
      sceneIds = [];
      const usage = new Map();

      for (let i = 0; i < timeline.length; i++) {
        const previous = sceneIds[i - 1] || null;
        let id = planned[i];

        const ranked = this.scoreScenes(hints ? hints[i] : timeline[i].text);
        const useCount = (candidate) => usage.get(candidate) || 0;

        if (!id) {
          if (ranked.length === 0) {
            // Konu hiçbir sahneye uymadı: soru işareti, doyarsa sakin bir dolgu sahnesi
            id = useCount('question') < 2
              ? 'question'
              : ['book', 'chart', 'sky', 'cloud_rain', 'sun'].find((c) => useCount(c) < 2) || 'question';
          } else {
            // Aynı sahne üst üste gelmesin, videoda en fazla 2 kez kullanılsın
            id = ranked.find((candidate) => candidate !== previous && useCount(candidate) < 2) ||
              this.relatedScene(ranked[0], usage, previous) ||
              ranked.find((candidate) => useCount(candidate) < 2) ||
              ranked[0];
          }
        } else if (useCount(id) >= 3) {
          // Ollama aynı sahneyi çok tekrar ettirdiyse alternatife geç
          id = ranked.find((candidate) => candidate !== id && useCount(candidate) < 2) ||
            (previous === 'question' ? 'generic' : 'question');
        }

        usage.set(id, useCount(id) + 1);
        sceneIds.push(id);
      }
    }

    const manifest = {
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      scenes: timeline.map((item, i) => ({
        id: sceneIds[i] || this.fallbackScene(item.text, sceneIds[i - 1]),
        duration: Math.max(1.2, item.duration),
        text: item.text
      }))
    };

    const manifestPath = path.join(workDir, 'whiteboard_manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    log2(`Sahne planı: ${manifest.scenes.map((s) => s.id).join(' → ')}`);

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

    const finalDuration = frames.length / FPS;
    const runInfo = await this.writeRunInfo(workDir, {
      video: path.basename(finalPath),
      scenes: manifest.scenes.map((sc) => sc.id),
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
