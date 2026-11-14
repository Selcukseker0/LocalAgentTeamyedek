import cron from 'node-cron';
import { config } from './config.js';
import { log } from './logger.js';
import { ManagerAgent } from './agents/ManagerAgent.js';

process.on('unhandledRejection', (err) => {
  log('System', `Yakalanmayan hata: ${err?.message || err}`, 'ERROR');
});
const manager = new ManagerAgent();
manager.startBot();

if (process.argv.includes('--run-now')) {
  log('System', 'Manuel test modu başladı...');
  const job = await manager.prepareDailyVideo();
  if (job) {
    await manager.sendToTelegramForApproval();
    log('System', 'Telegram önizlemesi atıldı. Onaylamak için bota /yayinla yaz.');
  }
} else {
  // 19:30 -> Araştır, yaz, seslendir, montajla, kalite kontrol et
  cron.schedule(config.prepareCron, async () => {
    await manager.prepareDailyVideo();
  });

  // 19:55 -> Telegram'a videoyu gönder
  cron.schedule(`${config.telegramMinute} ${config.telegramHour} * * *`, async () => {
    await manager.sendToTelegramForApproval();
  });

  // 20:00 -> İptal/Ertele yoksa YouTube'a yükle
  cron.schedule(`${config.publishMinute} ${config.publishHour} * * *`, async () => {
    await manager.publishPendingVideo();
  });

  log('System', 'LocalAgentTeam günlük Shorts otomasyonu başlatıldı.');
}