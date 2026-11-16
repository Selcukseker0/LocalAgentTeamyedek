import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseEnvContent, sanitizeEnvValue } from '../src/utils/envCheck.js';
import { loadEnvFile } from '../src/utils/envLoad.js';

async function writeEnv(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'envload-'));
  const file = path.join(dir, '.env');
  await fs.writeFile(file, content, 'utf8');
  return file;
}

test('anahtarın sonundaki nokta temizlenir (Groq 401 vakası)', () => {
  const { value, cleaned } = sanitizeEnvValue('LLM_API_KEY', 'gsk_c39YABC0mb6X.  ');
  assert.equal(value, 'gsk_c39YABC0mb6X');
  assert.match(cleaned, /temizlendi/);
});

test('serbest metin alanlarında nokta korunur', () => {
  const { value, cleaned } = sanitizeEnvValue('IMAGE_STYLE_PROMPT', 'siyah marker çizgi.');
  assert.equal(value, 'siyah marker çizgi.');
  assert.equal(cleaned, null);
});

test('tırnaklar ve satır sonu yorumu temizlenir', () => {
  assert.equal(sanitizeEnvValue('OLLAMA_MODEL', '"qwen2.5:7b"').value, 'qwen2.5:7b');
  assert.equal(sanitizeEnvValue('LLM_PROVIDER', 'groq   # ücretsiz').value, 'groq');
});

test('parseEnvContent temizlenen satırları ve satır numarasını bildirir', () => {
  const { values, cleaned, issues } = parseEnvContent('A=1\nLLM_API_KEY=gsk_abc123.\n');
  assert.equal(values.LLM_API_KEY, 'gsk_abc123');
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].line, 2);
  assert.ok(issues.some((item) => item.level === 'warn' && item.key === 'LLM_API_KEY'));
});

test('loadEnvFile değerleri düzeltip process.env yazar', async () => {
  const file = await writeEnv('LLM_MODEL=llama-3.3-70b-versatile.   \nGROUNDING_MIN_NUMBER=10\n');
  delete process.env.LLM_MODEL;
  delete process.env.GROUNDING_MIN_NUMBER;
  const report = loadEnvFile({ filePath: file, quiet: true, force: true });
  assert.equal(report.loaded, true);
  assert.equal(process.env.LLM_MODEL, 'llama-3.3-70b-versatile');
  assert.equal(process.env.GROUNDING_MIN_NUMBER, '10');
  assert.ok(report.cleaned.some((item) => item.key === 'LLM_MODEL'));
});

test('loadEnvFile kabukta verilmiş değeri ezmez', async () => {
  const file = await writeEnv('LLM_PROVIDER=groq\n');
  process.env.LLM_PROVIDER = 'ollama';
  const report = loadEnvFile({ filePath: file, quiet: true, reload: true });
  assert.equal(process.env.LLM_PROVIDER, 'ollama');
  assert.ok(report.skipped.includes('LLM_PROVIDER'));
});

test('dosya yoksa sessizce devam eder', () => {
  const report = loadEnvFile({ filePath: path.join(os.tmpdir(), 'yok-boyle-dosya.env'), quiet: true, reload: true });
  assert.equal(report.loaded, false);
});
