import { askOllama } from '../llm/ollamaClient.js';
import { log } from '../logger.js';

const MIN_WORDS = 45;
const MAX_WORDS = 65;

function cleanScript(script) {
  if (typeof script.title === 'string') {
    script.title = script.title.replace(/#shorts/gi, '').trim();
  }

  if (typeof script.narration === 'string') {
    script.narration = script.narration
      .replace(/\s+/g, ' ')
      .replace(/\.{3,}/g, '.')
      .replace(/\!{2,}/g, '!')
      .replace(/\?{2,}/g, '?')
      .trim();
  }

  return script;
}

function countWords(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function buildPrompt(topicObj, feedback = '') {
  return `Bir Türkçe YouTube Shorts senaryosu hazırla.

Konu: "${topicObj.topic}" (Kategori: ${topicObj.category})
${feedback ? `Önceki inceleme notu: ${feedback}` : ''}

Kurallar:
- narration yalnızca doğal, gündelik Türkçe olsun; 45-65 kelime, 6-8 kısa cümle yaz.
- Her cümle en fazla 12 kelime olsun. İlk cümle merak uyandırsın, son cümle kısa bir soru olsun.
- Emin olmadığın bilgiyi, özel terimi, sayıyı veya iddiayı uydurma; emin değilsen çıkar.
- Anlamsız kelime, başka dil veya sahne notu kullanma.
- visualQueries içinde anlatımla eşleşen 4 kısa İngilizce Pixabay araması yaz; elde beyaz kâğıt/tahta üzerine çizilen somut nesneleri tercih et.
- Başlığa #shorts ekleme.

Yalnızca şu JSON biçimini döndür:
{"title":"...", "description":"...", "tags":["..."], "narration":"...", "visualQueries":["...","...","...","..."]}`;
}

export class ScriptAgent {
  async generateScript(topicObj, feedback = '') {
    const system = 'Sen Türkçe yazan, doğal ve açık anlatımlı bir Shorts senaristisin. Uydurma kelime kullanma; yalnızca istenen JSON nesnesini döndür.';
    let script = cleanScript(await askOllama({
      system,
      prompt: buildPrompt(topicObj, feedback),
      json: true,
      temperature: 0.2
    }));

    let wordCount = countWords(script.narration);
    if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
      script = cleanScript(await askOllama({
        system,
        prompt: `Önceki JSON senaryo ${wordCount} kelimelikti; istenen 45-65 kelime aralığına uymadı.
Önceki JSON: ${JSON.stringify(script)}

Senaryoyu baştan yaz; eksik metne devam etme. narration 45-65 kelime ve 6-8 kısa cümle olsun.
Yalnızca doğal Türkçe kullan; uydurma terim, başka dil veya belirsiz iddia ekleme.
Yalnızca doğru JSON nesnesini döndür; aynı alanları koru.`,
        json: true,
        temperature: 0.1
      }));
      wordCount = countWords(script.narration);
    }

    if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
      throw new Error(`Ollama senaryosu ${MIN_WORDS}-${MAX_WORDS} kelime olmalı; ${wordCount} kelime üretildi.`);
    }

    const scriptText = `${script.title || ''} ${script.narration || ''}`;
    if (!/^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\s]*$/u.test(scriptText)) {
      throw new Error('Ollama senaryosu Türkçe dışı karakterler içeriyor; senaryo reddedildi.');
    }

    if (!Array.isArray(script.visualQueries) || script.visualQueries.length !== 4) {
      throw new Error('Ollama senaryosunda dört görsel arama terimi olmalı.');
    }

    log('ScriptAgent', `Senaryo: "${script.title}" (${wordCount} kelime) [Ollama]`);
    return script;
  }
}
