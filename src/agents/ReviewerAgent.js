import { askOllama } from '../llm/ollamaClient.js';

export class ReviewerAgent {
  async reviewScript(scriptObj) {
    return askOllama({
      system: `Sen titiz bir Türkçe YouTube Shorts editörüsün.
Senaryoda yalnızca anlaşılır ve doğal Türkçe olmalı. Uydurma/anlamsız kelime, başka dil veya şüpheli bilgi görürsen mutlaka reddet.
Tüm ölçütler karşılanmadıkça onay verme.
Sadece JSON döndür.`,
      json: true,
      temperature: 0.3,
      prompt: `Bu senaryoyu incele:

${JSON.stringify(scriptObj, null, 2)}

Değerlendirme kriterleri:
1. İlk 2 saniye dikkat çekiyor mu?
2. Cümleler anlaşılır Türkçe ve kısa mı? (en fazla 12 kelime)
3. Devrik cümle var mı?
4. Anlaşılmaz/uydurma kelime veya şüpheli bilgi var mı? Varsa onaylama ve bunları düzelt.
5. Toplam 45-65 kelime mi?
6. Yapay/AI vibes veriyor mu?

Sadece şu JSON formatında dön:
{"approved": true veya false, "score": 1-10, "feedback": "Ne düzeltilecek — somut ve kısa"}`
    });
  }
}