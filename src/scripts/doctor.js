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

  // 7) Birincil LLM sağlayıcısı (video başlamadan önce gerçek istek)
  const provider = (process.env.LLM_PROVIDER || 'ollama').trim().toLowerCase();
  const { CUSTOM_PRESETS } = await import('../llm/provider.js');
  const isCustom = provider === 'custom' || Boolean(CUSTOM_PRESETS[provider]);

  if (isCustom) {
    const started = Date.now();
    try {
      const { askLLM } = await import('../llm/provider.js');
      await askLLM({ prompt: 'Sadece "ok" yaz.', temperature: 0 });
      const endpoint = process.env.LLM_API_URL || CUSTOM_PRESETS[provider];
      record(true, `LLM (${provider})`, `${process.env.LLM_MODEL || '?'} · ${endpoint} · ${((Date.now() - started) / 1000).toFixed(1)} sn`);
    } catch (err) {
      record(
        false,
        `LLM (${provider})`,
        err.message,
        'LLM_API_KEY / LLM_MODEL doğru mu? Groq: api.groq.com · OpenRouter: openrouter.ai · ' +
        'LM Studio yerelde: LLM_PROVIDER=lmstudio (anahtar gerekmez)'
      );
    }
  } else if (provider === 'gemini' || provider === 'anthropic') {
    const started = Date.now();
    try {
      if (provider === 'gemini') {
        const { resolveGeminiModel, geminiGenerate } = await import('../llm/gemini.js');
        const model = await resolveGeminiModel();
        // Küçük ama gerçek istek: bağlantı + anahtar + model adı birlikte sınanır
        await geminiGenerate({
          model,
          body: {
            contents: [{ role: 'user', parts: [{ text: 'Sadece "ok" yaz.' }] }],
            generationConfig: { maxOutputTokens: 2048, temperature: 0 }
          },
          timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 30_000),
          retries: 1,
          label: 'doctor'
        });
        record(true, `Gemini (${provider})`, `${model} · ${((Date.now() - started) / 1000).toFixed(1)} sn`);
      } else {
        const { askLLM } = await import('../llm/provider.js');
        await askLLM({ prompt: 'Sadece "ok" yaz.', temperature: 0 });
        record(true, `Anthropic (${provider})`, `${((Date.now() - started) / 1000).toFixed(1)} sn`);
      }
    } catch (err) {
      const quota = /429|quota|exceeded/i.test(err.message);
      record(
        false,
        `${provider === 'gemini' ? 'Gemini' : 'Anthropic'} (birincil model)`,
        quota
          ? 'Kota doldu (429) — bağlantı çalışıyor, anahtarın ücretsiz kotası bitmiş.'
          : err.message,
        quota
          ? 'Yeni anahtar oluştur (aistudio.google.com/apikey — yeni proje = yeni kota) ya da bekle. ' +
            'Alternatif ücretsiz yol: LLM_PROVIDER=groq + LLM_API_KEY + LLM_MODEL, ' +
            'veya LLM_PROVIDER=ollama (yavaş).'
          : 'İnternet/VPN/güvenlik duvarı; GEMINI_MODEL boş bırakılırsa model otomatik seçilir. ' +
            'Bağlantı yoksa LLM_PROVIDER=ollama yap (yavaş olur) veya LLM_NO_FALLBACK=1 ile hızlı dur.'
      );
    }
  } else {
    record(true, 'LLM sağlayıcısı', 'ollama (yerel model, internet gerekmez)');
  }

  // 8) Ollama
  const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  try {
    const started = Date.now();
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const data = await res.json();
    const latency = Date.now() - started;
    const models = (data.models || []).map((m) => m.name);
    const wanted = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
    const hasModel = models.some((name) => name.startsWith(wanted.split(':')[0]));
    const gpuNote = process.env.OLLAMA_NUM_GPU === '0'
      ? ' ⚠️ OLLAMA_NUM_GPU=0 → CPU kilitli, yavaş olur'
      : '';
    record(
      hasModel,
      'Ollama',
      hasModel
        ? `çalışıyor (${latency} ms), ${wanted} bulundu${gpuNote}`
        : `çalışıyor ama "${wanted}" yok (mevcut: ${models.slice(0, 5).join(', ') || 'yok'})`,
      `ollama pull ${wanted}`
    );
    if (hasModel) {
      // Hız ölçümü: 7b CPU'da ~2 tok/s ise tek senaryo çağrısı dakikalar sürer
      const t0 = Date.now();
      try {
        await fetch(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: wanted,
            stream: false,
            keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
            options: { num_predict: 12, temperature: 0 },
            messages: [{ role: 'user', content: 'Tek kelimeyle yanıtla: hazır' }]
          }),
          signal: AbortSignal.timeout(120_000)
        });
        const ms = Date.now() - t0;
        const perToken = ms / 12;
        const note = perToken > 400
          ? `⚠️ yavaş (~${(perToken / 1000).toFixed(1)} sn/kelime) — GPU kullanılmıyor olabilir`
          : 'hız makul';
        record(perToken <= 400, 'Ollama hızı', `${(ms / 1000).toFixed(1)} sn (12 kelime) · ${note}`,
          'Ekran kartı sürücüsü/Ollama sürümü güncel mi? OLLAMA_NUM_GPU satırını boşalt. ' +
          'Küçük model: ollama pull qwen2.5:3b + OLLAMA_MODEL=qwen2.5:3b');
      } catch {
        record(false, 'Ollama hızı', 'ölçülemedi (ilk yükleme uzun sürüyor olabilir)',
          'Bir kez elle deneyin: ollama run ' + wanted);
      }
    }
  } catch {
    record(false, 'Ollama', `ulaşılamadı (${ollamaUrl})`,
      'Ollama uygulamasını aç veya "ollama serve" çalıştır');
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
