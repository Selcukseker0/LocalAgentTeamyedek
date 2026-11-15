/**
 * Tek video üretim hattı: konu → araştırma → senaryo → ses → beyaz tahta video.
 *
 * İki giriş noktası da (CLI `auto-video` ve Telegram/YouTube botu) buradan geçer;
 * böylece ikisi arasında kalite farkı oluşmaz. Adım adım ilerlemeyi `onStep`
 * geri çağrısıyla bildirir (CLI bunları ekrana basar).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { TrendAgent } from '../agents/TrendAgent.js';
import { ResearchAgent } from '../agents/ResearchAgent.js';
import { ReviewerAgent } from '../agents/ReviewerAgent.js';
import { ScriptAgent, countWords, splitSentences, estimateSeconds } from '../agents/ScriptAgent.js';
import { VoiceAgent } from '../agents/VoiceAgent.js';
import { WhiteboardVideoAgent } from '../agents/WhiteboardVideoAgent.js';
import { getAudioDuration } from '../utils/ffmpeg.js';

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function slugify(text) {
  return String(text || 'video')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'video';
}

async function audioSeconds(audioPath) {
  try {
    return await getAudioDuration(audioPath);
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string|null} options.topic      elle verilen konu (yoksa trend seçer)
 * @param {string} options.category        elle konu için kategori
 * @param {string|null} options.text       elle senaryo metni
 * @param {string[]|null} options.scenes   elle sahne zinciri
 * @param {boolean} options.review         ek LLM inceleme turu
 * @param {string|null} options.workDir    çalışma klasörü (yoksa output/auto/<ts>-<slug>)
 * @param {boolean} options.writeMetadata  youtube_metadata.json yazılsın mı
 * @param {object|null} options.voiceAgent  ses ajanı (test için değiştirilebilir)
 * @param {object|null} options.videoAgent  video ajanı (test için değiştirilebilir)
 * @param {(event: {step: string, data: object}) => void} options.onStep
 */
export async function generateShort({
  topic = null,
  category = null,
  text = null,
  scenes = null,
  review = false,
  workDir = null,
  writeMetadata = true,
  // Test/gömme için dışarıdan ajan verilebilir (varsayılan: gerçek ajanlar)
  voiceAgent = null,
  videoAgent = null,
  onStep = () => {}
} = {}) {
  const trend = new TrendAgent();
  const scriptAgent = new ScriptAgent();
  const reviewer = new ReviewerAgent();
  const researchAgent = new ResearchAgent();
  const voice = voiceAgent || new VoiceAgent();
  const video = videoAgent || new WhiteboardVideoAgent();
  const timings = {};

  // 1) Konu
  const topicObj = topic
    ? { topic, category: category || 'gündem', popularityScore: 100, source: 'manuel' }
    : await trend.pickDailyTopic();

  const dir = workDir
    || path.join(config.paths.outputDir, 'auto', `${stamp()}-${slugify(topicObj.topic)}`);
  await fs.mkdir(dir, { recursive: true });
  onStep({ step: 'topic', data: { topicObj, workDir: dir } });

  // 2) Senaryo
  let scriptObj;
  if (text) {
    scriptObj = {
      title: topicObj.topic,
      description: text.slice(0, 160),
      tags: [],
      narration: text.replace(/\s+/g, ' ').trim(),
      scenes: [],
      sceneHints: null,
      sceneObjects: null,
      labels: [],
      visualQueries: []
    };
    onStep({
      step: 'manual-text',
      data: {
        narration: scriptObj.narration,
        words: countWords(scriptObj.narration),
        sentences: splitSentences(scriptObj.narration).length
      }
    });
  } else {
    const researchStart = Date.now();
    const research = await researchAgent.research(topicObj.topic);
    timings.research = (Date.now() - researchStart) / 1000;
    onStep({ step: 'research', data: { research, seconds: timings.research } });

    const scriptStart = Date.now();
    scriptObj = await scriptAgent.generateScript(topicObj, '', research);
    timings.script = (Date.now() - scriptStart) / 1000;
    onStep({
      step: 'script',
      data: { script: scriptObj, seconds: timings.script, words: countWords(scriptObj.narration) }
    });
  }

  // İsteğe bağlı ek inceleme turu
  if (!text && review) {
    const reviewStart = Date.now();
    let verdict = await reviewer.reviewScript(scriptObj);
    if (!verdict.approved) {
      log('pipeline', `Reviewer revize istedi: ${verdict.feedback}`);
      scriptObj = await scriptAgent.generateScript(topicObj, verdict.feedback);
      verdict = await reviewer.reviewScript(scriptObj);
      if (!verdict.approved) {
        log('pipeline', `Senaryo onaylanmadı, yine de devam ediliyor: ${verdict.feedback}`, 'WARN');
      }
    }
    timings.review = (Date.now() - reviewStart) / 1000;
    onStep({ step: 'review', data: { verdict, seconds: timings.review } });
  }

  // 3) Ses (zorunlu)
  const voiceStart = Date.now();
  const voiceResult = await voice.synthesize(scriptObj.narration, dir);
  timings.voice = (Date.now() - voiceStart) / 1000;
  const seconds = await audioSeconds(voiceResult.audioPath);
  onStep({
    step: 'voice',
    data: { voiceResult, audioSeconds: seconds, seconds: timings.voice }
  });

  // 4) Video
  const videoStart = Date.now();
  const fileName = `shorts_whiteboard_${stamp()}.mp4`;
  const result = await video.renderShorts({
    audioPath: voiceResult.audioPath,
    srtPath: voiceResult.srtPath,
    narration: scriptObj.narration,
    sceneHints: scriptObj.sceneHints,
    sceneLabels: scriptObj.labels,
    sceneObjects: scriptObj.sceneObjects || null,
    words: voiceResult.words || null,
    topic: topicObj.topic,
    scenes: Array.isArray(scenes) && scenes.length ? scenes : null,
    workDir: dir,
    fileName
  });
  timings.video = (Date.now() - videoStart) / 1000;
  onStep({ step: 'video', data: { result, seconds: timings.video, image: video.image } });

  // 5) YouTube künyesi
  let metadataPath = null;
  if (writeMetadata) {
    metadataPath = path.join(dir, 'youtube_metadata.json');
    await fs.writeFile(metadataPath, JSON.stringify({
      title: `${scriptObj.title} #shorts`,
      description: scriptObj.description || scriptObj.title,
      tags: scriptObj.tags || []
    }, null, 2), 'utf8');
  }

  return {
    workDir: dir,
    topicObj,
    script: scriptObj,
    voice: voiceResult,
    audioSeconds: seconds,
    video: result,
    metadataPath,
    timings
  };
}

export { estimateSeconds };
