import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import { log } from '../logger.js';

export class TelegramAgent {
  constructor() {
    this.bot = null;
    this.decision = 'pending';
  }

  init(onImmediatePublish) {
    if (!config.telegramBotToken || !config.telegramChatId) {
      log('TelegramAgent', 'Telegram ayarları eksik, bot pasif.', 'WARN');
      return;
    }

    this.bot = new TelegramBot(config.telegramBotToken, { polling: true });
    const isOwner = (msg) => String(msg.chat.id) === String(config.telegramChatId);

    this.bot.onText(/\/yayinla/, async (msg) => {
      if (!isOwner(msg)) return;
      this.decision = 'publish';
      await this.bot.sendMessage(msg.chat.id, 'Onay alındı! Video hemen YouTube\'a yükleniyor...');
      if (onImmediatePublish) await onImmediatePublish();
    });

    this.bot.onText(/\/iptal/, async (msg) => {
      if (!isOwner(msg)) return;
      this.decision = 'cancel';
      await this.bot.sendMessage(msg.chat.id, 'Bugünkü yayın İPTAL edildi.');
    });

    this.bot.onText(/\/ertele/, async (msg) => {
      if (!isOwner(msg)) return;
      this.decision = 'postpone';
      await this.bot.sendMessage(msg.chat.id, 'Yayın ERTELENDİ. Bugün yüklenmeyecek.');
    });

    log('TelegramAgent', 'Telegram botu aktif ve komutları dinliyor.');
  }

  resetDecision() {
    this.decision = 'pending';
  }

   async sendPreview(videoPath, script) {
    if (!this.bot) return;
    const caption =
      `🎬 Günün Shorts Videosu Hazır!\n\n` +
      `Başlık: ${script.title}\n\n` +
      `20:00'da otomatik yayınlanacak.\n` +
      `Komutlar:\n/yayinla - Şimdi yükle\n/iptal - İptal et\n/ertele - Ertele`;
    try {
      await this.bot.sendVideo(config.telegramChatId, videoPath, { caption });
      log('TelegramAgent', 'Önizleme Telegram\'a gönderildi.');
    } catch (err) {
      log('TelegramAgent', `Önizleme gönderilemedi: ${err.message}`, 'ERROR');
    }
  }

  async notify(text) {
    if (!this.bot) return;
    try {
      await this.bot.sendMessage(config.telegramChatId, text);
    } catch (err) {
      log('TelegramAgent', `Mesaj gönderilemedi: ${err.message}`, 'ERROR');
    }
  }
}