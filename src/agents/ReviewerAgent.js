import { askLLM } from '../llm/provider.js';

export class ReviewerAgent {
  async reviewScript(scriptObj) {
    return askLLM({
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
2. Cümleler anlaşılır Türkçe ve kısa mı? (7-18 kelime, yarım cümle yok)
3. Devrik cümle var mı?
4. Anlaşılmaz/uydurma kelime veya şüpheli bilgi var mı? Varsa onaylama ve bunları düzelt.
5. Toplam 130-171 kelime (45-60 saniye) mi?
6. Yapay/AI vibes veriyor mu?
7. Her sahnede visual_prompt var mı ve cümlede anlatılan olayı mı tarif ediyor?

Sadece şu JSON formatında dön:
{"approved": true veya false, "score": 1-10, "feedback": "Ne düzeltilecek — somut ve kısa"}`
    });
  }
}