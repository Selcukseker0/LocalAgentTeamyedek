/**
 * `.env` dosyasını hazırlar.
 *
 * - `.env` varsa **üzerine yazmaz**; sadece boş bırakılmış önemli alanları söyler.
 * - Yoksa `.env.example` dosyasını kopyalar.
 *
 * Kullanım: npm run env:init
 */

import '../utils/envBootstrap.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

const IMPORTANT = [
  ['LLM_PROVIDER', 'ollama | gemini | anthropic (senaryo modeli)'],
  ['GEMINI_API_KEY', 'Gemini kullanacaksan'],
  ['OPENAI_API_KEY', 'OpenAI görseli kullanacaksan'],
  ['IMAGE_PROVIDER', 'openai | gemini | custom (sahne görselleri)'],
  ['IMAGE_MODEL', 'gemini: imagen-3.0-generate-002, openai: gpt-image-1'],
  ['TTS_VOICE', 'edge-tts sesi (varsayılan tr-TR-AhmetNeural)']
];

function parseEnv(content) {
  const values = new Map();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    values.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim());
  }
  return values;
}

async function main() {
  const exists = await fs.stat(ENV_PATH).then(() => true).catch(() => false);

  if (!exists) {
    const example = await fs.readFile(EXAMPLE_PATH, 'utf8').catch(() => null);
    if (example === null) {
      console.error('.env.example bulunamadı; depo eksik görünüyor.');
      process.exit(1);
    }
    await fs.writeFile(ENV_PATH, example, 'utf8');
    console.log('✅ .env oluşturuldu (.env.example kopyalandı).');
  } else {
    console.log('ℹ️  .env zaten var; üzerine yazılmadı.');
  }

  const content = await fs.readFile(ENV_PATH, 'utf8');
  const values = parseEnv(content);
  const empty = IMPORTANT.filter(([key]) => !values.get(key));

  console.log(`\nDosya: ${ENV_PATH}`);
  if (empty.length) {
    console.log('\nDoldurman gereken alanlar:');
    for (const [key, hint] of empty) {
      console.log(`  ${key.padEnd(18)} ${hint}`);
    }
    console.log('\nDüzenlemek için:  notepad .env');
  } else {
    console.log('Tüm önemli alanlar dolu görünüyor.');
  }

  console.log('\nİpucu: sadece yerel Ollama ile devam edeceksen hiçbir şey yazmana gerek yok.');
  console.log('Sahne görselleri için: IMAGE_PROVIDER=gemini + GEMINI_API_KEY=...');
}

main().catch((err) => {
  console.error(`Hata: ${err.message}`);
  process.exit(1);
});
