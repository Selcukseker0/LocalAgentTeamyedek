/**
 * Telegram/YouTube olmadan, günlük akışın tamamını çalıştırır:
 * Trend -> Senaryo -> İnceleme -> Seslendirme -> Beyaz tahta video.
 *
 * Kullanım:
 *   node src/scripts/autoVideo.js
 *   node src/scripts/autoVideo.js --topic "Buz neden kaygandır?"   # konuyu sen seç
 *   node src/scripts/autoVideo.js --no-review                      # inceleme adımını atla
 *
 * Gereksinimler: Ollama (senaryo/trend), edge-tts (ses), Pillow + ffmpeg (video).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { TrendAgent } from '../agents/TrendAgent.js';
import { ScriptAgent } from '../agents/ScriptAgent.js';
import { ReviewerAgent } from '../agents/ReviewerAgent.js';
import { VoiceAgent } from '../agents/VoiceAgent.js';
import { WhiteboardVideoAgent } from '../agents/WhiteboardVideoAgent.js';

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slugify(text) {
  return String(text || 'video')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'video';
}

async function main() {
  const started = Date.now();
  const ts = stamp();
  const workDir = path.join(config.paths.outputDir, 'auto', `${ts}-${slugify(argValue('topic', 'trend'))}`);
  await fs.mkdir(workDir, { recursive: true });

  const trend = new TrendAgent();
  const scriptAgent = new ScriptAgent();
  const reviewer = new ReviewerAgent();
  const voice = new VoiceAgent();
  const video = new WhiteboardVideoAgent();

  // 1) Konu
  const manualTopic = argValue('topic');
  const topicObj = manualTopic
    ? { topic: manualTopic, category: argValue('category', 'gündem'), popularityScore: 100, source: 'manuel' }
    : await trend.pickDailyTopic();
  console.log(`\n📌 Konu: ${topicObj.topic}  [${topicObj.category}]`);
  console.log(`   Çalışma klasörü: ${workDir}\n`);

  // 2) Senaryo (+ inceleme)
  let scriptObj = await scriptAgent.generateScript(topicObj);
  if (!hasFlag('no-review')) {
    let review = await reviewer.reviewScript(scriptObj);
    if (!review.approved) {
      log('autoVideo', `Reviewer revize istedi: ${review.feedback}`);
      scriptObj = await scriptAgent.generateScript(topicObj, review.feedback);
      review = await reviewer.reviewScript(scriptObj);
      if (!review.approved) {
        log('autoVideo', `Senaryo onaylanmadı, yine de devam ediliyor: ${review.feedback}`, 'WARN');
      }
    }
  }

  // 3) Ses
  const { audioPath, srtPath } = await voice.synthesize(scriptObj.narration, workDir);

  // 4) Video
  const fileName = `shorts_whiteboard_${ts}.mp4`;
  const result = await video.renderShorts({
    audioPath,
    srtPath,
    narration: scriptObj.narration,
    sceneHints: scriptObj.sceneHints,
    workDir,
    fileName
  });

  // 5) YouTube künyesi
  const metaPath = path.join(workDir, 'youtube_metadata.json');
  await fs.writeFile(metaPath, JSON.stringify({
    title: `${scriptObj.title} #shorts`,
    description: scriptObj.description || scriptObj.title,
    tags: scriptObj.tags || []
  }, null, 2), 'utf8');

  const stat = await fs.stat(result.videoPath);
  console.log('\n✅ Video hazır');
  console.log(`   Dosya: ${result.videoPath}`);
  console.log(`   Süre: ${result.duration.toFixed(1)}s | Kare: ${result.frameCount} | ` +
    `Boyut: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`   Sahneler: ${(result.scenes || []).join(' → ')}`);
  console.log(`   Önizleme: ${result.previewPath}`);
  console.log(`   Künye: ${metaPath}`);
  console.log(`   Toplam süre: ${((Date.now() - started) / 1000).toFixed(0)} sn`);

  if (result.duration < 40) {
    console.log('\n⚠️  Video 40 saniyeden kısa. TTS_WORDS_PER_SECOND değerini kontrol et ' +
      'veya .env içinde TTS_VOICE hızını düşür.');
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  if (/fetch failed|ECONNREFUSED/i.test(err.message)) {
    console.error('   Ollama çalışıyor mu? `ollama serve` ve `ollama pull qwen2.5:7b` gerekli.');
  }
  if (/edge_tts|No module named edge_tts/i.test(err.message)) {
    console.error('   Ses için: pip install edge-tts (internet bağlantısı gerekir).');
  }
  process.exit(1);
});
