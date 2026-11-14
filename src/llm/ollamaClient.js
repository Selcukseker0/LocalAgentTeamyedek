import { config } from '../config.js';

export async function askOllama({ system, prompt, json = false, temperature = 0.7 }) {
  const body = {
    model: config.ollamaModel,
    stream: false,
    options: {
      temperature,
      num_gpu: 0,
      num_predict: 512
    },
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