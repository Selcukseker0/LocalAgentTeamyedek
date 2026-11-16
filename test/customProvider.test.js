import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Gemini kotası dolduğunda kullanıcı ücretsiz/ucuz bir OpenAI-uyumlu sağlayıcıya
// (Groq, OpenRouter, Cerebras, yerel LM Studio) geçebilsin diye eklendi.

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  };
}

const OK = {
  choices: [{ message: { content: '{"ok":true}' } }]
};

let calls = [];
let script = [];

beforeEach(() => {
  calls = [];
  script = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || '{}') });
    const next = script.shift();
    if (!next) throw new Error(`beklenmeyen istek: ${url}`);
    return next;
  };
});

function setEnv(overrides = {}) {
  process.env.LLM_PROVIDER = 'groq';
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_MODEL = 'llama-3.3-70b-versatile';
  process.env.LLM_RETRIES = '2';
  delete process.env.LLM_API_URL;
  delete process.env.LLM_NO_FALLBACK;
  Object.assign(process.env, overrides);
}

test('groq/özel sağlayıcı hazır URL ile çağrılır (LLM_API_URL gerekmez)', async () => {
  setEnv();
  script = [jsonResponse(OK)];

  const { askLLM } = await import('../src/llm/provider.js?case=custom-url');
  const result = await askLLM({ prompt: 'test', json: true });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
});

test('sağlayıcı response_format desteklemezse JSON modu olmadan tekrar dener', async () => {
  setEnv();
  script = [
    jsonResponse({ error: 'response_format is not supported' }, 400),
    jsonResponse(OK)
  ];

  const { askLLM } = await import('../src/llm/provider.js?case=custom-400');
  const result = await askLLM({ prompt: 'test', json: true });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.ok('response_format' in calls[0].body);
  assert.ok(!('response_format' in calls[1].body));
});

test('429 gelirse bekleyip tekrar dener', async () => {
  setEnv();
  script = [jsonResponse({ error: 'rate limit' }, 429), jsonResponse(OK)];

  const { askLLM } = await import('../src/llm/provider.js?case=custom-429');
  const result = await askLLM({ prompt: 'test', json: true });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
});

test('LLM_MODEL boşsa model listesinden otomatik seçilir', async () => {
  setEnv({ LLM_MODEL: '', LLM_NO_FALLBACK: '1' });
  script = [
    jsonResponse({ data: [{ id: 'whisper-large-v3' }, { id: 'gpt-oss-120b' }, { id: 'llama-3.1-8b-instant' }] }),
    jsonResponse(OK)
  ];
  const { askLLM } = await import('../src/llm/provider.js?case=custom-nomodel');
  const result = await askLLM({ prompt: 'test', json: true });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/models');
  assert.equal(calls[1].body.model, 'gpt-oss-120b', 'ses modeli değil, sohbet modeli seçilmeli');
});

test('LLM_MODEL 404 verirse canlı listeden yeni model seçilip tekrar denenir', async () => {
  // Gerçek olay: llama-3.3-70b-versatile Groq'tan kaldırıldı → 404 model_not_found
  setEnv({ LLM_MODEL: 'llama-3.3-70b-versatile', LLM_NO_FALLBACK: '1' });
  script = [
    jsonResponse({ error: { message: 'The model `llama-3.3-70b-versatile` does not exist', code: 'model_not_found' } }, 404),
    jsonResponse({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'openai/gpt-oss-120b' }] }),
    jsonResponse(OK)
  ];
  const { askLLM, currentModel } = await import('../src/llm/provider.js?case=custom-404');
  const result = await askLLM({ prompt: 'test', json: true });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[1].url, 'https://api.groq.com/openai/v1/models');
  assert.equal(calls[2].body.model, 'openai/gpt-oss-120b');
  assert.equal(currentModel('groq'), 'openai/gpt-oss-120b');
});

test('Ollama akışı (NDJSON) birleştirilir ve JSON ayrıştırılır', async () => {
  process.env.LLM_PROVIDER = 'ollama';
  const lines = [
    { message: { content: '{"scenes":[' } },
    { message: { content: '{"narration":"Bal bozulmaz."}' } },
    { message: { content: ']}' } }
  ];
  const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  const encoder = new TextEncoder();
  let sawStream = null;

  globalThis.fetch = async (url, options = {}) => {
    sawStream = JSON.parse(options.body).stream;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      }
    });
    return { ok: true, status: 200, body, text: async () => text, json: async () => JSON.parse(text) };
  };

  const { askOllama } = await import('../src/llm/ollamaClient.js?case=stream');
  const result = await askOllama({ system: 's', prompt: 'p', json: true });

  assert.equal(sawStream, true, 'ilerleme görünsün diye akış istenmeli');
  assert.equal(result.scenes[0].narration, 'Bal bozulmaz.');
});

test('401 anahtar reddinde parmak izi yazar (değeri sızdırmaz)', async () => {
  setEnv({ LLM_API_KEY: 'gsk_abcdefghij0mb6X', LLM_NO_FALLBACK: '1' });
  script = [jsonResponse({ error: { message: 'Invalid API Key' } }, 401)];

  const { askLLM } = await import('../src/llm/provider.js?case=auth');
  await assert.rejects(
    () => askLLM({ prompt: 'test' }),
    (err) => {
      assert.match(err.message, /anahtar reddedildi/);
      assert.match(err.message, /karakter/);
      assert.ok(!err.message.includes('gsk_abcdefghij0mb6X'), 'anahtarın tamamı yazılmamalı');
      return true;
    }
  );
  assert.equal(calls.length, 1, '401 tekrar denenmez');
});
