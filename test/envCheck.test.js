import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { summarizeIssues, validateEnvFile } from '../src/utils/envCheck.js';

async function writeEnv(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcheck-'));
  const file = path.join(dir, '.env');
  await fs.writeFile(file, content, 'utf8');
  return file;
}

test('GROUNDING_MIN_NUMBER=10cls sayı değil diye hata verir', async () => {
  const file = await writeEnv('GROUNDING_MIN_NUMBER=10cls\n');
  const { issues, values } = await validateEnvFile(file);
  assert.equal(values.GROUNDING_MIN_NUMBER, '10cls');
  const error = issues.find((item) => item.key === 'GROUNDING_MIN_NUMBER');
  assert.ok(error, 'sorun bildirilmeli');
  assert.equal(error.level, 'error');
  assert.match(error.message, /sayı değil/);
});

test('aynı anahtar iki kez yazılırsa hata verir ve son değeri tutar', async () => {
  const file = await writeEnv('LLM_PROVIDER=gemini\nGEMINI_MODEL=\nLLM_PROVIDER=groq\n');
  const { issues, values } = await validateEnvFile(file);
  assert.equal(values.LLM_PROVIDER, 'groq');
  const dup = issues.find((item) => item.key === 'LLM_PROVIDER');
  assert.ok(dup);
  assert.equal(dup.level, 'error');
  assert.match(dup.message, /birden fazla/);
  assert.match(dup.message, /1\. ve 3\. satır/);
});

test('değerin sonundaki boşluk ve nokta temizlenir, uyarı verilir', async () => {
  const file = await writeEnv('LLM_API_KEY=gsk_c39YABCdef.   \nLLM_MODEL=llama-3.3-70b-versatile \n');
  const { issues, values } = await validateEnvFile(file);
  assert.equal(values.LLM_API_KEY, 'gsk_c39YABCdef');
  assert.equal(values.LLM_MODEL, 'llama-3.3-70b-versatile');
  const trail = issues.find((item) => item.key === 'LLM_API_KEY');
  assert.ok(trail);
  assert.equal(trail.level, 'warn');
});

test('tanınmayan sağlayıcı adı hata verir', async () => {
  const file = await writeEnv('LLM_PROVIDER=gemini-pro\n');
  const { issues } = await validateEnvFile(file);
  const error = issues.find((item) => item.key === 'LLM_PROVIDER');
  assert.ok(error);
  assert.equal(error.level, 'error');
  assert.match(error.message, /tanınmıyor/);
});

test('groq gibi ücretsiz sağlayıcılar geçerli sayılır', async () => {
  const file = await writeEnv('LLM_PROVIDER=groq\nVISION_PROVIDER=groq\nGROUNDING_MIN_NUMBER=10\n');
  const { issues } = await validateEnvFile(file);
  assert.deepEqual(issues, []);
  assert.equal(summarizeIssues(issues), '0 sorun (0 hata, 0 uyarı)');
});

test('yorumlar ve boş satırlar sorun sayılmaz', async () => {
  const file = await writeEnv('# başlık\n\nIMAGE_REQUEST_DELAY_MS=8000\n   \n');
  const { issues } = await validateEnvFile(file);
  assert.deepEqual(issues, []);
});

test('aralık dışı sayı uyarı verir', async () => {
  const file = await writeEnv('RESEARCH_FACT_OVERLAP=4\n');
  const { issues } = await validateEnvFile(file);
  const warn = issues.find((item) => item.key === 'RESEARCH_FACT_OVERLAP');
  assert.ok(warn);
  assert.equal(warn.level, 'warn');
  assert.equal(summarizeIssues(issues), '1 sorun (0 hata, 1 uyarı)');
});
