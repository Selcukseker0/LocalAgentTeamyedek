/**
 * Telegram/YouTube olmadan, günlük akışın tamamını çalıştırır:
 * Trend -> Araştırma -> Senaryo -> Seslendirme -> Beyaz tahta video.
 *
 * Kullanım:
 *   node src/scripts/autoVideo.js
 *   node src/scripts/autoVideo.js --topic "Buz neden kaygandır?"   # konuyu sen seç
 *   node src/scripts/autoVideo.js --review                         # ek Ollama incelemesi (yavaş)
 *   node src/scripts/autoVideo.js --text "Metin..."                # senaryoyu modelden istemez
 *   node src/scripts/autoVideo.js --scenes "coffee,map,chart"      # sahne zincirini elle ver
 *
 * Gereksinimler: Ollama (senaryo/trend), edge-tts (ses), Pillow + ffmpeg (video).
 * Üretim mantığı `src/pipeline/shortPipeline.js` içinde; bot da aynı hattı kullanır.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { countWords } from '../agents/ScriptAgent.js';
import { generateShort, estimateSeconds } from '../pipeline/shortPipeline.js';

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

async function main() {
  const started = Date.now();

  const envExists = await fs.stat(path.join(process.cwd(), '.env')).then(() => true).catch(() => false);
  if (!envExists) {
    console.log(
      'ℹ️  .env bulunamadı — varsayılan ayarlarla devam ediliyor.\n' +
      '   Oluşturmak için: npm run env:init\n'
    );
  }

  const manualScenes = (argValue('scenes') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const run = await generateShort({
    topic: argValue('topic'),
    category: argValue('category'),
    text: argValue('text'),
    scenes: manualScenes,
    review: hasFlag('review'),
    onStep: ({ step, data }) => {
      if (step === 'topic') {
        console.log(`\n📌 Konu: ${data.topicObj.topic}  [${data.topicObj.category}]`);
        console.log(`   Kaynak: ${data.topicObj.source || 'ollama'}`);
        console.log(`   Çalışma klasörü: ${data.workDir}\n`);
      } else if (step === 'research') {
        const { research, seconds } = data;
        if (research.facts.length) {
          console.log(
            `🔎 Araştırma: ${research.facts.length} doğrulanmış bilgi, ` +
            `${research.sources?.length || 1} kaynak ` +
            `(${research.title || 'Wikipedia'}, ${seconds.toFixed(0)} sn)`
          );
          research.facts.slice(0, 4).forEach((fact) => console.log(`   • ${fact}`));
        } else {
          console.log('🔎 Araştırma: kaynak bulunamadı, senaryo modelin bilgisiyle yazılacak.');
        }
      } else if (step === 'script') {
        console.log(
          `⏱️  Senaryo: ${data.seconds.toFixed(0)} sn ` +
          `(${data.script.scenes?.length || 0} sahne, ${data.words} kelime)`
        );
        const scenes = data.script.scenes || [];
        if (scenes.length) {
          console.log('🎬 Sahne taslağı:');
          scenes.slice(0, 20).forEach((scene, index) => {
            console.log(`   ${String(index + 1).padStart(2)}. ${scene.narration}`);
            const objects = Array.isArray(scene.visualObjects) && scene.visualObjects.length
              ? scene.visualObjects.join(', ')
              : '-';
            console.log(`       nesneler: ${objects}`);
            console.log(`       çizim: ${scene.imagePrompt || '-'}  | bant: ${scene.title || '-'}`);
          });
          console.log('');
        }
      } else if (step === 'manual-text') {
        console.log(
          `✍️  Elle verilen metin kullanılıyor: ${data.words} kelime, ` +
          `${data.sentences} cümle (~${estimateSeconds(data.narration).toFixed(0)} sn)\n`
        );
      } else if (step === 'review') {
        console.log(`⏱️  İnceleme: ${data.seconds.toFixed(0)} sn`);
      } else if (step === 'voice') {
        console.log(
          `⏱️  Seslendirme: ${data.seconds.toFixed(0)} sn ` +
          `(${data.audioSeconds ? `${data.audioSeconds.toFixed(1)} sn ses` : 'ses süresi okunamadı'})`
        );
      } else if (step === 'video') {
        console.log(`🖼️  ${data.image.statusLine()}`);
      }
    }
  });

  const { workDir, script, video, metadataPath } = run;
  const stat = await fs.stat(video.videoPath);
  console.log('\n✅ Video hazır');
  console.log(`   Dosya: ${video.videoPath}`);
  console.log(`   Süre: ${video.duration.toFixed(1)}s | Kare: ${video.frameCount} | ` +
    `Boyut: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`   Sahneler: ${(video.scenes || []).join(' → ')}`);

  const runInfoPath = path.join(workDir, 'run_info.json');
  const runInfo = JSON.parse(await fs.readFile(runInfoPath, 'utf8').catch(() => '{}'));
  const usedImages = (runInfo.scene_plan || []).filter((plan) => plan.image).length;
  console.log(`   Üretilmiş görsel: ${usedImages}/${(runInfo.scene_plan || []).length} sahne`);
  console.log(`   Kelime: ${countWords(script.narration)} | Önizleme: ${video.previewPath}`);
  if (metadataPath) console.log(`   Künye: ${metadataPath}`);
  console.log(`   Toplam süre: ${((Date.now() - started) / 1000).toFixed(0)} sn`);

  if (video.duration < 30) {
    console.log('\n⚠️  Video 30 saniyeden kısa. TTS_WORDS_PER_SECOND veya TTS_RATE değerini kontrol et.');
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
