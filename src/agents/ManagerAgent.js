import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { storage } from '../storage.js';
import { generateShort } from '../pipeline/shortPipeline.js';
import { DeveloperAgent } from './DeveloperAgent.js';
import { QualityAgent } from './QualityAgent.js';
import { TelegramAgent } from './TelegramAgent.js';
import { YouTubeAgent } from './YouTubeAgent.js';

export class ManagerAgent {
  constructor() {
    this.developer = new DeveloperAgent();
    this.quality = new QualityAgent();
    this.telegram = new TelegramAgent();
    this.youtube = new YouTubeAgent();
    this.pendingJob = null;
    this.isPublishing = false;
  }

  startBot() {
    this.telegram.init(async () => {
      await this.publishPendingVideo();
    });
  }

  async prepareDailyVideo() {
    this.telegram.resetDecision();
    const dateStamp = new Date().toISOString().slice(0, 10);
    const workDir = path.join(config.paths.outputDir, dateStamp);
    await fs.mkdir(workDir, { recursive: true });

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        log('ManagerAgent', `Günlük üretim başladı (Deneme ${attempt}/${maxAttempts})`);

        // CLI ile aynı hat: araştırma + çizilebilir senaryo + görsel + vision
        const run = await generateShort({ workDir });

        const qc = await this.quality.inspect(run.video.videoPath, run.voice.srtPath, run.video.duration);
        if (!qc.passed) {
          throw new Error(`Kalite kontrol geçemedi: ${qc.errors.join(', ')}`);
        }

        this.pendingJob = {
          topicObj: run.topicObj,
          scriptObj: run.script,
          videoPath: run.video.videoPath,
          workDir: run.workDir
        };
        log('ManagerAgent', 'Video hazır! Telegram gönderimini bekliyor.');
        return this.pendingJob;
      } catch (err) {
        log('ManagerAgent', `Deneme ${attempt} hatası: ${err.message}`, 'ERROR');
        if (attempt === maxAttempts) {
          const advice = await this.developer.analyzeError(err.message).catch(() => '');
          await this.telegram.notify(
            `❌ Video üretimi ${maxAttempts} denemede başarısız: ${err.message}\n\n🛠 Developer Notu: ${advice.slice(0, 400)}`
          );
        }
      }
    }
    return null;
  }

  async sendToTelegramForApproval() {
    if (!this.pendingJob) return;
    await this.telegram.sendPreview(this.pendingJob.videoPath, this.pendingJob.scriptObj);
  }

  async publishPendingVideo() {
    if (!this.pendingJob || this.isPublishing) return;

    if (this.telegram.decision === 'cancel' || this.telegram.decision === 'postpone') {
      log('ManagerAgent', `Yayın atlandı. Durum: ${this.telegram.decision}`);
      await storage.addRecord({
        topic: this.pendingJob.topicObj.topic,
        status: this.telegram.decision
      });
      this.pendingJob = null;
      return;
    }

    this.isPublishing = true;
    try {
      const { videoId, url } = await this.youtube.uploadVideo(
        this.pendingJob.videoPath,
        this.pendingJob.scriptObj
      );
      await storage.addRecord({
        topic: this.pendingJob.topicObj.topic,
        title: this.pendingJob.scriptObj.title,
        videoId,
        url,
        status: 'published'
      });
      await this.telegram.notify(`✅ Video YouTube'a yüklendi!\n${url}`);
      this.pendingJob = null;
    } catch (err) {
      log('ManagerAgent', `YouTube yükleme hatası: ${err.message}`, 'ERROR');
      await this.telegram.notify(`❌ YouTube yükleme hatası: ${err.message}`);
    } finally {
      this.isPublishing = false;
    }
  }
}