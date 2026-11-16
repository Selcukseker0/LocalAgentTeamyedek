/**
 * Beyaz tahta stilini tek başına denemek için küçük CLI.
 *
 * Örnekler:
 *   node src/scripts/whiteboardDemo.js
 *   node src/scripts/whiteboardDemo.js --text "Bal neden bozulmaz? ..." --srt data/demo.srt
 *   node src/scripts/whiteboardDemo.js --audio output/voice.mp3 --srt output/subs.srt --text "..."
 *
 * Ses dosyası verilmezse video sessiz üretilir (altyazılar yine gömülür).
 */

import '../utils/envBootstrap.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { WhiteboardVideoAgent } from '../agents/WhiteboardVideoAgent.js';
import { resolveBinaries } from '../utils/ffmpeg.js';

/** Gerekli araçları (Python + Pillow + ffmpeg) erkenden kontrol eder. */
async function preflight(agent) {
  let python;
  try {
    python = await agent.resolvePython();
  } catch {
    throw new Error(
      'Python 3 bulunamadı. https://www.python.org/downloads/ adresinden kurun ' +
      've kurulumda "Add python.exe to PATH" seçeneğini işaretleyin.'
    );
  }

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)(python, ['-c', 'import PIL']);
  } catch {
    throw new Error(
      `Pillow kurulu değil. Şunu çalıştırın: ${python} -m pip install Pillow`
    );
  }

  try {
    const { ffmpeg } = await resolveBinaries();
    console.log(`ffmpeg: ${ffmpeg}`);
  } catch {
    throw new Error(
      'ffmpeg bulunamadı. Şunu çalıştırın: ' +
      `${python} -m pip install imageio-ffmpeg ` +
      '(veya FFMPEG_PATH ortam değişkenine ffmpeg.exe yolunu yazın).'
    );
  }
}

// Demo metinleri: her çalıştırmada rastgele biri seçilir (hep aynı video çıkmasın).
// Gerçek akış için `npm run auto-video` kullan: trend konusunu kendi bulur.
const SAMPLE_NARRATIONS = [
  // ~137 kelime ≈ 45-50 saniye
  "Mısır'daki bir mezarda üç bin yıllık bal bulundu ve hâlâ yenebilir durumdaydı. " +
  'Bu, balın neden asla bozulmadığını merak ettiriyor. ' +
  'Normalde süt birkaç günde ekşir, ekmek ise küflenir. ' +
  'Balın sırrı, içindeki su miktarının çok az olmasında saklı. ' +
  'Bakteriler su olmadan çoğalamaz, bu yüzden bal onlar için kuru bir çöl gibidir. ' +
  'İkinci sebep ise balın asidik yapısı. ' +
  'Balın pH değeri çoğu bakterinin yaşayamayacağı kadar düşük. ' +
  'Üçüncü sebep, arıların bala eklediği doğal enzimler. ' +
  'Bu enzimler hidrojen peroksit üretir ve mikropları etkisiz hale getirir. ' +
  'Peki bal her koşulda bozulmaz mı? ' +
  'Hayır, bal suya temas ederse fermente olabilir. ' +
  'Bu yüzden balı kuru ve kapalı saklamak gerekir. ' +
  'Kristalleşen bal bozulmuş değildir, sadece şekeri çökelmiştir. ' +
  'Ilık suda bekletmek onu tekrar akıcı hale getirir. ' +
  'Bu sayede bal, yüzyıllar boyunca tazeliğini koruyabilir. ' +
  'Sence mutfağında en uzun dayanan yiyecek hangisi?',

  // ~139 kelime ≈ 45-50 saniye
  'Gökyüzü neden mavidir, hiç merak ettin mi? ' +
  'Güneş ışığı aslında bütün renkleri birlikte taşır. ' +
  'Atmosferdeki moleküller mavi ışığı diğerlerinden çok saçar. ' +
  'Bu saçılma yüzünden gökyüzüne baktığımızda maviyi görürüz. ' +
  'Gün batımında ışık atmosferde daha uzun bir yol alır. ' +
  'Mavi ışık yolda dağılıp gider, geriye kırmızı ve turuncu kalır. ' +
  'Bu yüzden ufuk akşamları kızıl bir renge bürünür. ' +
  'Uzayda ise atmosfer yoktur. ' +
  'Bu yüzden astronotlar gökyüzünü gündüz bile simsiyah görür. ' +
  "Mars'ta atmosfer ince olduğu için gökyüzü kahverengimsi görünür. " +
  "Güneş battığında ise Mars'ta mavi bir parıltı oluşur. " +
  'Gökyüzünün rengi, atmosferin kalınlığına ve tozuna bağlıdır. ' +
  'Bu yüzden her gezegenin gökyüzü farklı bir renktedir. ' +
  'Bilim insanları uzak gezegenlerin rengini simüle edebiliyor. ' +
  'Bu bilgi, teleskoplarla yapılan ölçümlerle doğrulanıyor. ' +
  'Yani gökyüzü dediğimiz şey aslında bir ışık oyunudur. ' +
  'Atmosfer olmasaydı gökyüzü her yerde karanlık olurdu. ' +
  'Sence hangi gezegenin gökyüzünü görmek isterdin?',

  // ~131 kelime ≈ 45 saniye
  'Buz neden bu kadar kaygandır, hiç düşündün mü? ' +
  'Aslında buzu kaygan yapan şey buzun kendisi değildir. ' +
  'Yüzeyinde oluşan çok ince bir su tabakası vardır. ' +
  'Ayak bastığında basınç buzu anında biraz eritir. ' +
  'Bu ince su filmi, ayağınla zemin arasında kaygan bir yastık oluşturur. ' +
  'Kayakçılar bu yüzden buz üzerinde neredeyse sürtünmesiz kayar. ' +
  'Peki hava çok soğuk olduğunda neden daha az kayarız? ' +
  'Çünkü eksi otuz derecede o su tabakası zar zor oluşur. ' +
  'Bilim insanları bu konuyu yüz yıldır tartışıyor. ' +
  'Bazı ölçümler yüzeyde gerçekten sıvı bir katman buluyor. ' +
  'Bu katman, buzun kristal yapısından kaynaklanıyor. ' +
  'Yani buz, göründüğü kadar basit bir madde değildir. ' +
  'Kışın arabanın kapısı da bu yüzden donar. ' +
  'Donmuş kapıyı zorlamak yerine biraz beklemek gerekir. ' +
  'Buz üzerinde yürürken küçük adımlar düşmeyi zorlaştırır. ' +
  'Yola tuz dökmek ise buzu daha da hızlı eritir. ' +
  'Sence en kaygan zemin doğal olarak hangisi?',

  // ~131 kelime ≈ 45 saniye
  "Kahve dünyayı nasıl değiştirdi, hiç düşündün mü? " +
  "Kahve ilk olarak Etiyopya'da keşfedildi. " +
  'Bir çoban, keçilerinin bu meyveyi yedikten sonra hareketlendiğini fark etti. ' +
  "Yemen üzerinden Ortadoğu'ya, oradan da Avrupa'ya yayıldı. " +
  'Kahve çekirdeği aslında bir meyvenin çekirdeğidir. ' +
  "Avrupa'da ilk kahvehaneler hızla buluşma noktası oldu. " +
  'Tüccarlar haberleri, sanatçılar fikirlerini burada paylaştı. ' +
  'Bazı hükümdarlar bu sohbetlerden korkup kahveyi yasakladı. ' +
  'Ama yasaklar işe yaramadı, kahve daha da yayıldı. ' +
  'Kavurma sıcaklığı tadı tamamen değiştirir. ' +
  'Uzmanlar bu yüzden her çekirdek için farklı profil kullanır. ' +
  'Bugün dünyada günde iki milyardan fazla fincan kahve içiliyor. ' +
  'Kahve, sabah rutininin yanında küçük bir ekonomi yarattı. ' +
  'Bir fincan kahvenin arkasında yetiştiriciden baristaya uzun bir yol var. ' +
  'Tek bir fincan için yaklaşık elli çekirdek kullanılıyor. ' +
  'Soğuk demleme yöntemi daha yumuşak bir tat bırakıyor. ' +
  'Kahvenin kokusu bile uyanıklığı bir miktar artırabiliyor. ' +
  'Peki sabah kahven olmasa günün nasıl başlardı?'
];


// Örnekler sırayla döner: her demo bir öncekinden farklı bir konu çıkarır.
// (Son seçim `output/whiteboard-demo/.last-sample` dosyasında tutulur.)
function pickSample(previousIndex = -1) {
  const total = SAMPLE_NARRATIONS.length;
  const index = previousIndex < 0
    ? Math.floor(Math.random() * total)
    : (previousIndex + 1) % total;
  return { index, text: SAMPLE_NARRATIONS[index] };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

/** Altyazı yoksa cümleleri eşit süreyle bölen basit bir SRT üretir. */
function buildSrt(narration, totalDuration) {
  const sentences = narration
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .filter(Boolean);

  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0) || 1;
  const fmt = (sec) => {
    const ms = Math.round(sec * 1000);
    const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
    const r = String(ms % 1000).padStart(3, '0');
    return `${h}:${m}:${s},${r}`;
  };

  let cursor = 0;
  return sentences
    .map((sentence, i) => {
      const duration = Math.max(1.2, (sentence.length / totalChars) * totalDuration);
      const block = `${i + 1}\n${fmt(cursor)} --> ${fmt(cursor + duration)}\n${sentence}\n`;
      cursor += duration;
      return block;
    })
    .join('\n');
}

const LAST_SAMPLE_FILE = '.last-sample';

async function readLastSample(outDir) {
  try {
    const raw = await fs.readFile(path.join(outDir, LAST_SAMPLE_FILE), 'utf8');
    const index = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(index) ? index : -1;
  } catch {
    return -1;
  }
}

async function main() {
  const audioArg = argValue('audio');
  const srtArg = argValue('srt');
  const outDir = path.resolve(argValue('out', path.join(config.paths.outputDir, 'whiteboard-demo')));

  await fs.mkdir(outDir, { recursive: true });

  const textArg = argValue('text');
  let narration = textArg;
  let sampleIndex = -1;
  if (!narration) {
    const previous = await readLastSample(outDir);
    const picked = pickSample(previous);
    narration = picked.text;
    sampleIndex = picked.index;
    await fs.writeFile(path.join(outDir, LAST_SAMPLE_FILE), String(sampleIndex), 'utf8');
    console.log(
      `ℹ️  Rastgele örnek metin #${sampleIndex + 1} kullanıldı ` +
      `(${narration.split(/\s+/).filter(Boolean).length} kelime, ~` +
      `${(narration.split(/\s+/).filter(Boolean).length / 2.9).toFixed(1)} sn).\n` +
      '   Trend konusundan kendi senaryosunu üretmesi için: npm run auto-video\n'
    );
  }
  narration = narration.replace(/\s+/g, ' ').trim();

  console.log(`Çalışma klasörü: ${outDir}`);

  let srtPath = null;
  if (srtArg) {
    srtPath = path.resolve(srtArg);
  } else {
    // edge-tts tr-TR ~2.9 kelime/saniye (TTS_WORDS_PER_SECOND ile uyumlu)
    const estimated = Math.max(6, narration.split(/\s+/).length / 2.9);
    srtPath = path.join(outDir, 'demo.srt');
    await fs.writeFile(srtPath, buildSrt(narration, estimated), 'utf8');
    console.log(`Altyazı üretildi: ${srtPath} (~${estimated.toFixed(1)}s)`);
  }

  const agent = new WhiteboardVideoAgent();
  await preflight(agent);

  if (audioArg) {
    const audioPath = path.resolve(audioArg);
    const exists = await fs.stat(audioPath).then(() => true).catch(() => false);
    if (!exists) throw new Error(`Ses dosyası bulunamadı: ${audioPath}`);
  }

  const fileName = `shorts_whiteboard_${stamp()}.mp4`;
  const { videoPath, duration, frameCount, previewPath, scenes } = await agent.renderShorts({
    audioPath: audioArg ? path.resolve(audioArg) : null,
    srtPath,
    narration,
    // Konu sahnesi (eşleşmeyen cümlelerde kullanılır): metnin ilk cümlesi
    topic: narration.split(/(?<=[.!?…])\s+/)[0] || narration,
    workDir: outDir,
    fileName
  });

  const stat = await fs.stat(videoPath);
  const hash = crypto.createHash('sha1').update(await fs.readFile(videoPath))
    .digest('hex').slice(0, 12);

  console.log(`\n✅ Video hazır: ${videoPath}`);
  console.log(`   Süre: ${duration.toFixed(1)}s | 1080x1920 | ${audioArg ? 'sesli' : 'sessiz'}`);
  console.log(`   Kare: ${frameCount} | Boyut: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`   SHA1: ${hash}  (her çalıştırmada farklı olur)`);
  console.log(`   Sahneler: ${(scenes || []).join(' → ')}`);
  if (previewPath) console.log(`   Önizleme: ${previewPath}`);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
