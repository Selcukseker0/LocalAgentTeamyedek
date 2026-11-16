/**
 * `.env` dosyası ayrıştırma (parse) ve denetimi.
 *
 * Gerçek olaylar:
 *   1) `GROUNDING_MIN_NUMBER=10cls` yazılmıştı. `Number('10cls')` = NaN olduğu
 *      için uydurma-sayı kontrolü sessizce **tamamen kapandı** — hata vermedi.
 *   2) Aynı anahtar iki kez yazılınca (LLM_PROVIDER=gemini ... sonra =groq)
 *      hangisinin geçerli olduğu belirsizleşiyor.
 *   3) Anahtar sohbetten kopyalanınca sonunda nokta kalıyor: `gsk_...0mb6X.`
 *      → Groq 401 "Invalid API Key". Uyarı vermek yetmedi, **düzeltmek** gerekti.
 *
 * Bu modül hem denetler (issues) hem de temizlenmiş değerleri döndürür
 * (values + cleaned). `envLoad.js` bu değerleri `process.env`'e yazar.
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
 * Değeri olan anahtarlar: sonundaki nokta asla gerçek veri değildir.
 * (`IMAGE_STYLE_PROMPT` gibi serbest metinlere dokunmuyoruz — orada nokta
 * gerçek bir cümle sonu olabilir.)
 */
const NO_TRAILING_DOT = /_(KEY|TOKEN|SECRET|ID|MODEL|URL)$/;

/**
 * Tek bir değeri normalize eder: tırnakları çıkarır, satır sonu yorumunu atar,
 * baştaki/sondaki boşluğu (ve gerekiyorsa noktayı) temizler.
 *
 * @returns {{value: string, cleaned: string|null}}
 */
export function sanitizeEnvValue(key, rawValue) {
  let value = String(rawValue ?? '').trim();
  let cleaned = null;

  // "..." / '...' : tırnak içindeki boşluklar korunur
  const quoted = value.match(/^(['"])([\s\S]*)\1$/);
  if (quoted) {
    value = quoted[2];
    if (quoted[1] === '"') value = value.replace(/\\n/g, '\n');
    return { value: value.trimEnd(), cleaned: null };
  }

  // Satır sonu yorumu: FOO=bar   # açıklama
  const hash = value.search(/\s#/);
  if (hash >= 0) value = value.slice(0, hash).trim();

  if (NO_TRAILING_DOT.test(key) && /[.]+$/.test(value)) {
    const stripped = value.replace(/[.]+$/, '');
    if (stripped) {
      cleaned = 'sonundaki "." temizlendi';
      value = stripped;
    }
  }

  return { value, cleaned };
}

/**
 * Ham `.env` içeriğini ayrıştırır.
 *
 * @param {string} raw
 * @returns {{
 *   values: Record<string,string>,
 *   entries: Array<{key:string, value:string, line:number}>,
 *   cleaned: Array<{key:string, line:number, what:string, value:string}>,
 *   issues: Array<{level:'error'|'warn', key:string|null, message:string}>
 * }}
 */
export function parseEnvContent(raw) {
  const issues = [];
  const values = {};
  const entries = [];
  const cleaned = [];
  const seen = new Map();

  String(raw ?? '')
    .split(/\r?\n/)
    .forEach((line, index) => {
      const lineNo = index + 1;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) {
        issues.push({
          level: 'warn',
          key: null,
          message: `${lineNo}. satır anlaşılmadı: ${trimmed.slice(0, 60)}`
        });
        return;
      }

      const key = match[1];
      const { value, cleaned: what } = sanitizeEnvValue(key, match[2]);
      if (what) {
        cleaned.push({ key, line: lineNo, what, value });
        issues.push({
          level: 'warn',
          key,
          message: `${key}: ${lineNo}. satırda ${what} — değer okunurken düzeltildi (dosyayı da temizleyin).`
        });
      }

      if (seen.has(key)) {
        issues.push({
          level: 'error',
          key,
          message: `${key} birden fazla tanımlı (${seen.get(key)}. ve ${lineNo}. satır). Son satır geçerli olur; birini silin.`
        });
      }
      seen.set(key, lineNo);
      values[key] = value;
      entries.push({ key, value, line: lineNo });

      const numeric = NUMERIC_KEYS[key];
      if (numeric && value !== '') {
        const [type, min, max] = numeric;
        const pattern = type === 'int' ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/;
        if (!pattern.test(value)) {
          issues.push({
            level: 'error',
            key,
            message: `${key}="${value}" sayı değil. Bu hâliyle kod varsayılana döner veya kontrol sessizce kapanır (${lineNo}. satır).`
          });
        } else {
          const num = Number(value);
          if (num < min || num > max) {
            issues.push({
              level: 'warn',
              key,
              message: `${key}=${num} beklenen aralığın dışında (${min}-${max}).`
            });
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

  return { values, entries, cleaned, issues };
}

/**
 * @param {string} filePath
 * @returns {Promise<{values: object, entries: Array, cleaned: Array, issues: Array}>}
 */
export async function validateEnvFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return {
      values: {},
      entries: [],
      cleaned: [],
      issues: [{ level: 'warn', key: null, message: `${filePath} okunamadı` }]
    };
  }
  return parseEnvContent(raw);
}

/** Özet satırı: "3 sorun (2 hata, 1 uyarı)" */
export function summarizeIssues(issues) {
  const errors = issues.filter((item) => item.level === 'error').length;
  const warns = issues.length - errors;
  return `${issues.length} sorun (${errors} hata, ${warns} uyarı)`;
}

/**
 * Anahtarın kimliğini sızdırmadan parmak izi: "52 karakter · gsk_…b6X".
 * 401 hatasında yapıştırılan anahtarın gerçekten yeni anahtar mı, yoksa
 * kopyalama kalıntısı mı olduğunu görmek için.
 */
export function fingerprintSecret(secret) {
  const value = String(secret ?? '').trim();
  if (!value) return 'boş';
  const head = value.slice(0, 4);
  const tail = value.slice(-3);
  return `${value.length} karakter · ${head}…${tail}`;
}

/** Sağlayıcıya göre anahtar biçimi (kopyalama kalıntısını/eksik yapıştırmayı yakalar). */
const KEY_FORMATS = {
  groq: [/^gsk_[A-Za-z0-9]{40,}$/, 'gsk_ ile başlar ve ~52 karakterdir'],
  openrouter: [/^sk-or-v1-[A-Za-z0-9]{40,}$/, 'sk-or-v1- ile başlar'],
  gemini: [/^[A-Za-z0-9_\-]{20,}$/, 'AIza… ya da AQ.… biçiminde'],
  anthropic: [/^sk-ant-[A-Za-z0-9_\-]{20,}$/, 'sk-ant- ile başlar']
};

/**
 * @returns {string|null} uyarı metni ya da biçim beklenmiyorsa null
 */
export function keyFormatWarning(provider, key) {
  const value = String(key ?? '').trim();
  const rule = KEY_FORMATS[String(provider ?? '').toLowerCase()];
  if (!value || !rule) return null;
  const [pattern, note] = rule;
  if (pattern.test(value)) return null;
  return `LLM_API_KEY biçimi ${provider} anahtarına benzemiyor (${fingerprintSecret(value)}). Beklenen: ${note}`;
}
