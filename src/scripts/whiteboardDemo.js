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

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { WhiteboardVideoAgent } from '../agents/WhiteboardVideoAgent.js';

const DEFAULT_NARRATION =
  "Mısır'daki mezarlarda 3000 yıllık bal bulundu ve hâlâ yenebilir durumdaydı. " +
  'Bir süt birkaç günde bozulurken, bal nasıl bozulmuyor? ' +
  'Birincisi, bal çok az su içerir. Bakteriler susuz ortamda çoğalamaz. ' +
  'İkincisi, bal asidik ve şeker oranı çok yüksek. Bu da bakterileri kurutur. ' +
  'Peki balın bozulmaması için tek şart bu mu?';

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

async function main() {
  const narration = argValue('text', DEFAULT_NARRATION).replace(/\s+/g, ' ').trim();
  const audioArg = argValue('audio');
  const srtArg = argValue('srt');
  const outDir = path.resolve(argValue('out', path.join(config.paths.outputDir, 'whiteboard-demo')));

  await fs.mkdir(outDir, { recursive: true });
  console.log(`Çalışma klasörü: ${outDir}`);

  let srtPath = null;
  if (srtArg) {
    srtPath = path.resolve(srtArg);
  } else {
    // ~2.6 kelime/saniye konuşma hızı varsayımı
    const estimated = Math.max(6, narration.split(/\s+/).length / 2.6);
    srtPath = path.join(outDir, 'demo.srt');
    await fs.writeFile(srtPath, buildSrt(narration, estimated), 'utf8');
    console.log(`Altyazı üretildi: ${srtPath} (~${estimated.toFixed(1)}s)`);
  }

  const agent = new WhiteboardVideoAgent();
  const { videoPath, duration } = await agent.renderShorts({
    audioPath: audioArg ? path.resolve(audioArg) : null,
    srtPath,
    narration,
    workDir: outDir
  });

  console.log(`\n✅ Video hazır: ${videoPath}`);
  console.log(`   Süre: ${duration.toFixed(1)}s | 1080x1920 | ${audioArg ? 'sesli' : 'sessiz'}`);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
