import { config } from '../config.js';

/**
 * Google Gemini ile metin üretimi.
 * Ollama yerine, özellikle Türkçe yaratıcı yazı için kullanılır.
 */
export async function askGemini({ system = '', prompt = '', json = false, temperature = 0.8 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY tanımlı değil (.env dosyasını kontrol et).');
  }

  const model = 'gemini-3.8-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature,
      maxOutputTokens: 2048
    }
  };

  if (system) {
    body.systemInstruction = {
      parts: [{ text: system }]
    };
  }

  if (json) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API hatası (${res.status}): ${text}`);
  }

  const data = await res.json();
  const content =
    data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

  if (!content) {
    throw new Error('Gemini boş yanıt döndürdü.');
  }

  if (json) {
    try {
      return JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error(`Gemini geçerli JSON döndürmedi: ${content.slice(0, 300)}`);
    }
  }

  return content;
}