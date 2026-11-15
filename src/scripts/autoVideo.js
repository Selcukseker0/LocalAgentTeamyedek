/**
 * Telegram/YouTube olmadan, günlük akışın tamamını çalıştırır:
 * Trend -> Senaryo -> İnceleme -> Seslendirme -> Beyaz tahta video.
 *
 * Kullanım:
 *   node src/scripts/autoVideo.js
 *   node src/scripts/autoVideo.js --topic "Buz neden kaygandır?"   # konuyu sen seç
 *   node src/scripts/autoVideo.js --review                         # ek Ollama incelemesi (yavaş)
 *   node src/scripts/autoVideo.js --text "Metin..."                # senaryoyu Ollama'ya yazdırma
 *   node src/scripts/autoVideo.js --scenes "coffee,map,chart"      # sahne zincirini elle ver
 *
 * Gereksinimler: Ollama (senaryo/trend), edge-tts (ses), Pillow + ffmpeg (video).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { TrendAgent } from '../agents/TrendAgent.js';
import { ScriptAgent, countWords, splitSentences, estimateSeconds } from '../agents/ScriptAgent.js';
import { ReviewerAgent } from '../agents/ReviewerAgent.js';
import { ResearchAgent } from '../agents/ResearchAgent.js';
import { VoiceAgent } from '../agents/VoiceAgent.js';
import { WhiteboardVideoAgent } from '../agents/WhiteboardVideoAgent.js';
import { getAudioDuration } from '../utils/ffmpeg.js';

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

async function voiceDuration(audioPath) {
  try {
    return await getAudioDuration(audioPath);
  } catch {
    return null;
  }
}

async function main() {
  const started = Date.now();
  const ts = stamp();

  const trend = new TrendAgent();
  const scriptAgent = new ScriptAgent();
  const reviewer = new ReviewerAgent();
  const researchAgent = new ResearchAgent();
  const voice = new VoiceAgent();
  const video = new WhiteboardVideoAgent();

  // 1) Konu
  const manualTopic = argValue('topic');
  const topicObj = manualTopic
    ? { topic: manualTopic, category: argValue('category', 'gündem'), popularityScore: 100, source: 'manuel' }
    : await trend.pickDailyTopic();
  // Klasör adı seçilen konudan üretilir (her çalıştırma ayrı klasör)
  const workDir = path.join(
    config.paths.outputDir,
    'auto',
    `${ts}-${slugify(topicObj.topic)}`
  );
  await fs.mkdir(workDir, { recursive: true });

  console.log(`\n📌 Konu: ${topicObj.topic}  [${topicObj.category}]`);
  console.log(`   Kaynak: ${topicObj.source || 'ollama'}`);
  console.log(`   Çalışma klasörü: ${workDir}\n`);

  // 2) Senaryo (+ inceleme)
  const manualText = argValue('text');
  let scriptObj;
  if (manualText) {
    const sentences = splitSentences(manualText);
    scriptObj = {
      title: topicObj.topic,
      description: manualText.slice(0, 160),
      tags: [],
      narration: manualText.replace(/\s+/g, ' ').trim(),
      sceneHints: null,
      visualQueries: []
    };
    console.log(
      `✍️  Elle verilen metin kullanılıyor: ${countWords(scriptObj.narration)} kelime, ` +
      `${sentences.length} cümle (~${estimateSeconds(scriptObj.narration).toFixed(0)} sn)\n`
    );
  } else {
    // 2a) Konu hakkında doğrulanmış bilgi (Wikipedia). Ağ yoksa boş döner.
    const researchStart = Date.now();
    const research = await researchAgent.research(topicObj.topic);
    if (research.facts.length) {
      console.log(
        `🔎 Araştırma: ${research.facts.length} bilgi ` +
        `(${research.title || topicObj.topic}, ${((Date.now() - researchStart) / 1000).toFixed(0)} sn)`
      );
    }

    const t0 = Date.now();
    scriptObj = await scriptAgent.generateScript(topicObj, '', research);
    console.log(
      `⏱️  Senaryo: ${((Date.now() - t0) / 1000).toFixed(0)} sn ` +
      `(${scriptObj.scenes?.length || 0} sahne, ${countWords(scriptObj.narration)} kelime)`
    );
  }

  if (Array.isArray(scriptObj.scenes) && scriptObj.scenes.length) {
    console.log('🎬 Sahne taslağı:');
    scriptObj.scenes.slice(0, 20).forEach((scene, index) => {
      console.log(`   ${String(index + 1).padStart(2)}. ${scene.narration}`);
      console.log(`       çizim: ${scene.visualPrompt || '-'}  | bant: ${scene.title || '-'}`);
    });
    console.log('');
  }

  // Ek Ollama incelemesi varsayılan olarak kapalı: her tur ~1 dakika ekliyor.
  // (Senaryo zaten kelime/cümle/kalıp kontrollerinden geçiyor.)
  if (!manualText && hasFlag('review')) {
    const t0 = Date.now();
    let review = await reviewer.reviewScript(scriptObj);
    if (!review.approved) {
      log('autoVideo', `Reviewer revize istedi: ${review.feedback}`);
      scriptObj = await scriptAgent.generateScript(topicObj, review.feedback);
      review = await reviewer.reviewScript(scriptObj);
      if (!review.approved) {
        log('autoVideo', `Senaryo onaylanmadı, yine de devam ediliyor: ${review.feedback}`, 'WARN');
      }
    }
    console.log(`⏱️  İnceleme: ${((Date.now() - t0) / 1000).toFixed(0)} sn`);
  }

  // 3) Ses
  const voiceStarted = Date.now();
  const voiceResult = await voice.synthesize(scriptObj.narration, workDir);
  const { audioPath, srtPath } = voiceResult;
  const audioSeconds = await voiceDuration(audioPath);
  console.log(
    `⏱️  Seslendirme: ${((Date.now() - voiceStarted) / 1000).toFixed(0)} sn ` +
    `(${audioSeconds ? `${audioSeconds.toFixed(1)} sn ses` : 'ses süresi okunamadı'})`
  );

  // 4) Video
  const fileName = `shorts_whiteboard_${ts}.mp4`;
  const manualScenes = (argValue('scenes') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const result = await video.renderShorts({
    audioPath,
    srtPath,
    narration: scriptObj.narration,
    sceneHints: scriptObj.sceneHints,
    sceneLabels: scriptObj.labels,
    words: voiceResult.words || null,
    topic: topicObj.topic,
    scenes: manualScenes.length ? manualScenes : null,
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
