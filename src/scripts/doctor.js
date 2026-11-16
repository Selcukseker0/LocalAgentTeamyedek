/**
 * Ortam kontrolü ("doktor").
 *
 * Kurulumdan sonra tek komutla her şeyin yerinde olup olmadığını söyler:
 * doğru klasörde miyiz, Node sürümü yeterli mi, Python paketleri kurulu mu,
 * ffmpeg bulundu mu, Ollama çalışıyor mu, .env var mı?
 *
 *   npm.cmd run doctor
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const results = [];

function record(ok, label, detail, fix) {
  results.push({ ok, label, detail, fix });
}

async function exists(target) {
  return fs.stat(target).then(() => true).catch(() => false);
}

/** Python'da tek tek paket dener; eksikleri tek satırda toplar. */
async function checkPython(pythonBin) {
  const modules = [
    ['PIL', 'Pillow', 'kare çizimi + kapak'],
    ['edge_tts', 'edge-tts', 'Türkçe seslendirme'],
    ['imageio_ffmpeg', 'imageio-ffmpeg', 'ffmpeg ikilisi (PATH\'te yoksa)']
  ];
  const missing = [];
  let version = null;

  for (const [module, packageName, purpose] of modules) {
    try {
      const { stdout } = await execFileAsync(
        pythonBin,
        ['-c', `import ${module}; print(getattr(${module}, "__version__", "ok"))`],
        { timeout: 20000 }
      );
      if (module === 'PIL') version = `Pillow ${stdout.trim()}`;
    } catch {
      missing.push(`${packageName} (${purpose})`);
    }
  }

  if (missing.length) {
    record(false, 'Python paketleri', `eksik: ${missing.join(', ')}`,
      'python -m pip install -r requirements.txt');
  } else {
    record(true, 'Python paketleri', `tamam (${version || 'Pillow kurulu'})`);
  }
}

async function main() {
  console.log(`\n🩺 Ortam kontrolü — ${root}\n`);

  // 1) Doğru klasör / git deposu
  const isGit = await exists(path.join(root, '.git'));
  record(isGit, 'Git deposu',
    isGit ? 'bu klasör bir klon' : 'bu klasör git deposu değil (ZIP kopyası?)',
    'Doğru klasöre geç (-git ile biten klon) veya yeniden: git clone https://github.com/Selcukseker0/LocalAgentTeamyedek.git');

  // 2) Node sürümü
  const major = Number(process.versions.node.split('.')[0]);
  record(major >= 20, 'Node.js', `v${process.versions.node}`,
    'Node.js 20+ kur: https://nodejs.org');

  // 3) node_modules
  const hasModules = await exists(path.join(root, 'node_modules'));
  record(hasModules, 'npm paketleri',
    hasModules ? 'node_modules var' : 'node_modules yok',
    'npm.cmd install');

  // 4) .env
  const hasEnv = await exists(path.join(root, '.env'));
  record(hasEnv, '.env dosyası',
    hasEnv ? 'var' : 'yok (bot/YouTube anahtarları boş kalır, üretim yine çalışır)',
    'npm.cmd run env:init');

  // 5) Python + paketler
  const pythonBin = process.env.PYTHON_BIN || 'python';
  try {
    const { stdout } = await execFileAsync(pythonBin, ['--version'], { timeout: 20000 });
    record(true, 'Python', stdout.trim());
    await checkPython(pythonBin);
  } catch {
    record(false, 'Python', `"${pythonBin}" çalıştırılamadı`,
      'python --version çalışıyor mu? Değilse .env içine PYTHON_BIN=tam\\yol\\python.exe yaz.');
  }

  // 6) ffmpeg
  try {
    const { resolveBinaries } = await import('../utils/ffmpeg.js');
    const { ffmpeg } = await resolveBinaries();
    record(true, 'ffmpeg', ffmpeg);
  } catch (err) {
    record(false, 'ffmpeg', err.message, 'pip.cmd install imageio-ffmpeg veya FFMPEG_PATH ayarla');
  }

  // 7) Ollama
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2500) });
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    const wanted = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
    const hasModel = models.some((name) => name.startsWith(wanted.split(':')[0]));
    record(hasModel, 'Ollama', hasModel
      ? `çalışıyor, ${wanted} bulundu`
      : `çalışıyor ama "${wanted}" yok (mevcut: ${models.slice(0, 5).join(', ') || 'yok'})`,
    `ollama pull ${wanted}`);
  } catch {
    record(false, 'Ollama', 'ulaşılamadı (127.0.0.1:11434)',
      'Ollama uygulamasını aç veya "ollama serve" çalıştır');
  }

  // 8) Bulut LLM (Gemini): gerçekten ulaşılabiliyor mu?
  const llmProvider = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
  if (llmProvider === 'gemini') {
    if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
      record(false, 'Gemini', 'LLM_PROVIDER=gemini ama GEMINI_API_KEY boş', '.env içine GEMINI_API_KEY yaz');
    } else {
      try {
        const { pingGemini } = await import('../llm/provider.js');
        const ping = await pingGemini();
        record(true, 'Gemini', `çalışıyor (${ping.model}, ${(ping.ms / 1000).toFixed(1)} sn)`);
      } catch (err) {
        record(false, 'Gemini', err.message,
          'Model adı (GEMINI_MODEL), anahtar ve internet/VPN/proxy kontrolü; "bağlantı hatası" ise NODE_OPTIONS=--dns-result-order=ipv4first dene');
      }
    }
  } else {
    record(true, 'LLM', `${llmProvider} (senaryo ${llmProvider === 'ollama' ? 'yerel/yavaş olabilir' : 'bulut'})`);
  }

  // Rapor
  let critical = 0;
  for (const item of results) {
    const mark = item.ok ? '✅' : '❌';
    console.log(`${mark} ${item.label}: ${item.detail}`);
    if (!item.ok) {
      critical += 1;
      if (item.fix) console.log(`   → ${item.fix}`);
    }
  }

  const warningsOnly = results.filter((r) => !r.ok && r.label === '.env dosyası').length;
  console.log('');
  if (critical === 0) {
    console.log('✅ Her şey hazır. `npm.cmd run auto-video` ile video üretebilirsin.');
  } else if (critical === warningsOnly) {
    console.log('⚠️  Zorunlu bileşenler tamam; sadece .env eksik (bot/YouTube için gerekli).');
  } else {
    console.log(`❌ ${critical} sorun var. Yukarıdaki "→" satırlarını sırayla uygula.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n❌ Kontrol çalıştırılamadı: ${err.message}`);
  process.exit(1);
});
