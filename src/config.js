import path from 'node:path';
import { loadEnvFile } from './utils/envLoad.js';

// .env'i kendimiz yükleriz: dotenv değerleri olduğu gibi alır, biz ise
// sondaki nokta/boşluğu temizleriz (Groq 401'inin sebebi buydu). Zaten
// yüklendiyse tekrar okumaz.
loadEnvFile({ quiet: true });

// dotenv yalnızca .env kolaylığı sağlar. Bağımlılıklar kurulu değilse
// (ör. sadece beyaz tahta demosunu denemek isteyen kullanıcı) süreç
// çökmemeli; ortam değişkenleri doğrudan kullanılır.
try {
  const dotenv = await import('dotenv');
  (dotenv.default ?? dotenv).config({ override: false });
} catch {
  console.warn(
    '[config] dotenv bulunamadı, .env yüklenmedi. Önce `npm install`, ' +
    'sonra `npm run env:init` ile .env dosyasını oluşturun.'
  );
}

export const config = {
  ollamaUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
  prepareCron: process.env.PREPARE_CRON || '30 19 * * *',
  telegramHour: Number(process.env.TELEGRAM_HOUR ?? 19),
  telegramMinute: Number(process.env.TELEGRAM_MINUTE ?? 55),
  publishHour: Number(process.env.PUBLISH_HOUR ?? 20),
  publishMinute: Number(process.env.PUBLISH_MINUTE ?? 0),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  youtube: {
    clientId: process.env.YOUTUBE_CLIENT_ID || '',
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
    redirectUri: process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3000/oauth2callback',
    privacyStatus: process.env.YOUTUBE_PRIVACY_STATUS || 'unlisted',
    tokenPath: path.resolve('data/youtube_token.json')
  },
  ttsVoice: process.env.TTS_VOICE || 'tr-TR-AhmetNeural',
  // edge-tts hızı: +20% Türkçe için doğal, 30-45 sn hedefi buna göre
  ttsRate: process.env.TTS_RATE || '+20%',
  pythonBin: process.env.PYTHON_BIN || 'python',
  paths: {
    dataDir: path.resolve('data'),
    outputDir: path.resolve('output'),
    historyFile: path.resolve('data/history.json'),
    logFile: path.resolve('data/system.log')
  }
};