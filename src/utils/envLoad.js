/**
 * `.env` dosyasını yükler — ve yüklerken **düzeltir**.
 *
 * Sadece uyarı vermek yetmedi: kullanıcı `.env`e Groq anahtarını sohbetten
 * kopyaladı, sonunda nokta kaldı (`gsk_...0mb6X.`). Dosya "geçerli" göründü,
 * üretim başladı, 401 "Invalid API Key" ile durdu. Artık değer okunurken
 * temizleniyor (bkz. envCheck.js `sanitizeEnvValue`).
 *
 * Sıra önemli: bu modül, `process.env`'i modül yüklenirken okuyan dosyalardan
 * (ScriptAgent'taki GROUNDING_MIN_NUMBER gibi) ÖNCE çalışmalı. Bu yüzden giriş
 * betiklerinin ilk import'u `envBootstrap.js`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseEnvContent } from './envCheck.js';

const STORE = Symbol.for('localagent.envReport');

/** Daha önce yüklenen rapor (yoksa null). */
export function getEnvReport() {
  return globalThis[STORE] || null;
}

/**
 * @param {{filePath?: string, quiet?: boolean, force?: boolean, reload?: boolean}} [options]
 *   force  : dosyadaki değer kabukta verilmiş olsa bile yazılır
 *   reload : önbelleği yok sayar (normalde dosya bir kez okunur)
 * @returns {{loaded: boolean, path: string, cleaned: Array, issues: Array,
 *            applied: number, skipped: string[]}}
 */
export function loadEnvFile({ filePath, quiet = false, force = false, reload = false } = {}) {
  const target = filePath || path.resolve(process.cwd(), '.env');

  const previous = getEnvReport();
  if (previous && !force && !reload) return previous;

  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    const missing = { loaded: false, path: target, cleaned: [], issues: [], applied: 0, skipped: [] };
    globalThis[STORE] = missing;
    return missing;
  }

  const { values, cleaned, issues } = parseEnvContent(raw);
  const skipped = [];
  let applied = 0;

  for (const [key, value] of Object.entries(values)) {
    // Kabukta açıkça verilen değer dosyayı yener (dotenv ile aynı davranış).
    if (!force && process.env[key] !== undefined && process.env[key] !== '') {
      skipped.push(key);
      continue;
    }
    process.env[key] = value;
    applied += 1;
  }

  const report = { loaded: true, path: target, cleaned, issues, applied, skipped };
  globalThis[STORE] = report;

  if (!quiet) printEnvReport(report);
  return report;
}

/** Uyarıları tek satırda, değer sızdırmadan yazar. */
export function printEnvReport(report) {
  if (!report?.loaded) return;
  if (!report.cleaned.length) return;
  for (const item of report.cleaned) {
    console.log(`🔧 .env: ${item.key} — ${item.line}. satırda ${item.what} (okurken düzeltildi).`);
  }
  console.log('   Dosyayı da düzeltin ki uyarı kalksın: notepad .env\n');
}
