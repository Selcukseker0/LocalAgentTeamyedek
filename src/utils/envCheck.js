/**
 * `.env` dosyası denetimi.
 *
 * Gerçek olay: `GROUNDING_MIN_NUMBER=10cls` yazılmıştı. `Number('10cls')` = NaN
 * olduğu için uydurma sayı kontrolü sessizce **tamamen kapandı** — hata vermedi.
 * Ayrıca aynı anahtar iki kez yazılınca (LLM_PROVIDER=gemini ... sonra =groq)
 * hangisinin geçerli olduğu belirsizleşiyor.
 *
 * Bu modül bunları yakalar: sayısal alanlarda bozuk değer, tekrarlanan anahtar,
 * baştaki/sondaki boşluk ve '.', bilinmeyen sağlayıcı adı.
 */

import fs from 'node:fs/promises';

/** Sayı beklenen anahtarlar: [tip, min, max] */
const NUMERIC_KEYS = {
  GEMINI_TIMEOUT_MS: ['int', 1000, 600000],
  LLM_RETRIES: ['int', 1, 10],
  LLM_API_TIMEOUT_MS: ['int', 1000, 600000],
  LLM_BREAKER_FAILURES: ['int', 1, 10],
  OLLAMA_TIMEOUT_MS: ['int', 10000, 3600000],
  OLLAMA_SLOW_WARN_MS: ['int', 1000, 3600000],
  OLLAMA_NUM_PREDICT: ['int', 50, 8192],
  OLLAMA_NUM_GPU: ['int', 0, 999],
  GROUNDING_MIN_NUMBER: ['int', 0, 1000000],
  RESEARCH_MIN_MATCH: ['float', 0, 1],
  RESEARCH_FACT_OVERLAP: ['float', 0, 1],
  SCRIPT_BUDGET_SEC: ['int', 30, 7200],
  SCRIPT_FALLBACK_SCENES: ['int', 1, 40],
  SCRIPT_FALLBACK_WORDS: ['int', 10, 500],
  SCRIPT_MIN_SCORE: ['int', 1, 10],
  IMAGE_REQUEST_DELAY_MS: ['int', 0, 300000],
  IMAGE_429_RETRIES: ['int', 1, 20],
  IMAGE_MAX_ATTEMPTS: ['int', 1, 10],
  IMAGE_VISION_PASS: ['int', 1, 10],
  RENDER_WORKERS: ['int', 1, 32],
  TTS_WORDS_PER_SECOND: ['float', 0.5, 10],
  MUSIC_VOLUME: ['float', 0, 1],
  MUSIC_FADE_OUT: ['float', 0, 10]
};

const PROVIDERS = new Set([
  'ollama', 'gemini', 'anthropic', 'custom',
  'groq', 'openrouter', 'cerebras', 'together', 'lmstudio', 'llamacpp',
  'openai'
]);

const VISION_PROVIDERS = new Set(['gemini', 'openai', 'custom', 'groq', 'openrouter']);

/**
 * @param {string} filePath
 * @returns {Promise<{values: object, issues: Array<{level:'error'|'warn', key:string|null, message:string}>}>}
 */
export async function validateEnvFile(filePath) {
  const issues = [];
  const values = {};
  const seen = new Map();

  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return { values, issues: [{ level: 'warn', key: null, message: `${filePath} okunamadı` }] };
  }

  const lines = raw.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      issues.push({ level: 'warn', key: null, message: `${index + 1}. satır anlaşılmadı: ${trimmed.slice(0, 60)}` });
      return;
    }

    const key = match[1];
    let value = match[2].trim();

    // Sondaki boşluk/nokta: kopyala-yapıştır kalıntısı
    if (/[.\s]+$/.test(match[2]) && match[2].trim().length) {
      issues.push({
        level: 'warn',
        key,
        message: `${index + 1}. satırda değerin sonunda boşluk/nokta var ("${value.slice(-6)}") — temizleyin.`
      });
      value = value.replace(/[.\s]+$/, '');
    }

    if (seen.has(key)) {
      issues.push({
        level: 'error',
        key,
        message: `${key} birden fazla tanımlı (${seen.get(key)}. ve ${index + 1}. satır). Son satır geçerli olur; birini silin.`
      });
    }
    seen.set(key, index + 1);
    values[key] = value;

    const numeric = NUMERIC_KEYS[key];
    if (numeric && value !== '') {
      const [type, min, max] = numeric;
      const pattern = type === 'int' ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/;
      if (!pattern.test(value)) {
        issues.push({
          level: 'error',
          key,
          message: `${key}="${value}" sayı değil. Bu hâliyle kod varsayılana döner veya kontrol sessizce kapanır (${index + 1}. satır).`
        });
      } else {
        const num = Number(value);
        if (num < min || num > max) {
          issues.push({ level: 'warn', key, message: `${key}=${num} beklenen aralığın dışında (${min}-${max}).` });
        }
      }
    }
  });

  if (values.LLM_PROVIDER && !PROVIDERS.has(values.LLM_PROVIDER.toLowerCase())) {
    issues.push({
      level: 'error',
      key: 'LLM_PROVIDER',
      message: `LLM_PROVIDER="${values.LLM_PROVIDER}" tanınmıyor. Geçerli: ${[...PROVIDERS].join(', ')}`
    });
  }

  if (values.VISION_PROVIDER && !VISION_PROVIDERS.has(values.VISION_PROVIDER.toLowerCase())) {
    issues.push({
      level: 'error',
      key: 'VISION_PROVIDER',
      message: `VISION_PROVIDER="${values.VISION_PROVIDER}" tanınmıyor. Geçerli: ${[...VISION_PROVIDERS].join(', ')}`
    });
  }

  return { values, issues };
}

/** Özet satırı: "3 sorun (2 hata, 1 uyarı)" */
export function summarizeIssues(issues) {
  const errors = issues.filter((item) => item.level === 'error').length;
  const warns = issues.length - errors;
  return `${issues.length} sorun (${errors} hata, ${warns} uyarı)`;
}
