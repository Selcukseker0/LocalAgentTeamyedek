import { config } from '../config.js';

// Uzun senaryolar (130+ kelime + JSON alanları) 512 token'a sığmıyordu;
// 900 token 130-140 kelimelik senaryo için yeterli ve daha hızlı.
const DEFAULT_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT || 900);
// num_gpu tanımlı değilse Ollama kendi karar verir (GPU varsa GPU kullanır).
// Önceden sabit `num_gpu: 0` CPU'ya kilitliyordu ve yavaşlığın ana sebebiydi.
const NUM_GPU = process.env.OLLAMA_NUM_GPU;
// Modeli bellekte tut: her istekte 4.7 GB modelin yeniden yüklenmesini önler.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';

export async function askOllama({
  system,
  prompt,
  json = false,
  temperature = 0.7,
  numPredict = DEFAULT_NUM_PREDICT
}) {
  const options = {
    temperature,
    num_predict: numPredict
  };
  if (NUM_GPU !== undefined && NUM_GPU !== '') {
    options.num_gpu = Number(NUM_GPU);
  }

  const body = {
    model: config.ollamaModel,
    stream: false,
    keep_alive: KEEP_ALIVE,
    options,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ]
  };
  if (json) body.format = 'json';

  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama API hatası (${res.status}): ${text}`);
  }

  const data = await res.json();
  const content = data?.message?.content?.trim() || '';

  if (json) {
    try {
      return JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error(`Ollama geçerli JSON döndürmedi: ${content.slice(0, 200)}`);
    }
  }
  return content;
}