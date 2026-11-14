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

  /** Sahne yoksa basit anahtar kelime eşlemesi (Türkçe ekleri tolere eder). */
  fallbackScene(text, previous = null) {
    const t = (text || '').toLocaleLowerCase('tr');
    const rules = [
      ['egyptian_vase', ['mısır', 'misir', 'mezar', 'vazo', 'firavun', 'antik', 'hiyeroglif']],
      ['bacteria_honey', ['bakteri', 'mikrop', 'kurut', 'mikroskop']],
      ['water_drop', ['su', 'damla', 'nem', 'ıslak', 'islak']],
      ['milk_bread_honey', ['süt', 'sut', 'ekmek', 'bozul', 'gıda', 'gida']],
      ['honey_pot', ['bal', 'reçel', 'rec el', 'tatlı', 'tatli']],
      ['clock', ['yıl', 'yil', 'zaman', 'saat', 'gün', 'gun', 'süre', 'sure']],
      ['sun', ['güneş', 'gunes', 'sıcak', 'sicak']],
      ['heart', ['kalp', 'sevgi', 'sağlık', 'saglik']],
      ['money', ['para', 'fiyat', 'ekonomi', 'zengin']],
      ['book', ['kitap', 'okul', 'bilgi', 'öğren', 'ogren']],
      ['question', ['neden', 'nasıl', 'nasil', 'merak']]
    ];

    const scores = rules.map(([id, keywords]) => {
      const score = keywords.reduce((sum, kw) => {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(?<![\\p{L}])${escaped}`, 'iu');
        return sum + (pattern.test(t) ? 1 : 0);
      }, 0);
      return { id, score };
    });

    // Soru cümlesi ama başka güçlü bir sahne yoksa soru işareti çizilir
    const bestOther = Math.max(
      0, ...scores.filter((s) => s.id !== 'question').map((s) => s.score)
    );
    if (/\?\s*$/.test(t) && bestOther < 2) {
      const q = scores.find((s) => s.id === 'question');
      if (q) q.score = bestOther + 1;
    }

    scores.sort((a, b) => b.score - a.score);
    const best = scores.find((s) => s.score > 0);
    if (!best) return 'question';
    // Aynı sahne üst üste gelmesin
    if (best.id === previous) {
      const alt = scores.find((s) => s.score > 0 && s.id !== previous);
      return alt ? alt.id : best.id;
    }
    return best.id;
  }

  // -------------------------------------------------------------- görüntü

  async renderFrames(manifestPath, framesDir, srtPath = null) {
    const python = await this.resolvePython();
    log2('Kareler çiziliyor (Pillow)...');
    const args = [RENDER_SCRIPT, '--manifest', manifestPath, '--out', framesDir,
      '--fps', String(FPS), '--size', `${WIDTH}x${HEIGHT}`];
    if (srtPath) args.push('--srt', srtPath);
    const { stdout } = await execFileAsync(python, args, { maxBuffer: 8 * 1024 * 1024 });
    if (stdout.trim()) log2(stdout.trim());
  }

  async encodeVideo({ framesDir, audioPath, outPath, frameCount }) {
    const { ffmpeg } = await resolveBinaries();
    const args = [
      '-y',
      '-framerate', String(FPS),
      '-i', path.join(framesDir, 'frame_%05d.png')
    ];
    if (audioPath) args.push('-i', audioPath);

    args.push(
      '-frames:v', String(frameCount),
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
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
  async renderShorts({ audioPath, srtPath, narration, workDir, scenes = null }) {
    const framesDir = path.join(workDir, 'frames');
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
      sceneIds = [];
      for (let i = 0; i < timeline.length; i++) {
        const previous = sceneIds[i - 1] || null;
        sceneIds.push(planned[i] || this.fallbackScene(timeline[i].text, previous));
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

    await this.renderFrames(manifestPath, framesDir, srtPath);
    const frames = (await fs.readdir(framesDir)).filter((f) => f.endsWith('.png'));
    if (frames.length === 0) throw new Error('Hiç kare üretilmedi.');

    const finalPath = path.join(workDir, 'shorts_whiteboard.mp4');
    await this.encodeVideo({
      framesDir,
      audioPath: hasAudio ? audioPath : null,
      outPath: finalPath,
      frameCount: frames.length
    });

    const finalDuration = frames.length / FPS;
    log2(`Shorts hazır: ${finalPath} (${finalDuration.toFixed(1)}s, ${frames.length} kare)`);
    return { videoPath: finalPath, duration: finalDuration };
  }
}

export const WHITEBOARD_SCENES = SCENE_IDS;
