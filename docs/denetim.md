# Proje denetimi (v6)

Tüm depo baştan sona gezildi: her dosya, her ajan, her env değişkeni ve her script.
Aşağıda **ne silindi**, **ne düzeltildi**, **neyin kalması gerektiği** ve **sıradaki
iyileştirmeler** var. Bu turda yapılanlar bu dalda; yapılmayanlar "öneri" olarak işaretli.

Özet: **19 dosya, +529 / −893 satır** (net −364). 5 ölü dosya silindi, iki giriş noktası
tek hatta bağlandı, ilk kez otomatik test altyapısı geldi (14 test, `npm test`).

---

## 1. Silinenler (ve neden)

| Dosya / blok | Satır | Neden silindi |
|---|---|---|
| `src/agents/BaseAgent.js` | 0 | Boş dosya, hiçbir yerden import edilmiyordu. |
| `src/agents/VideoAgent.js` | 227 | Pixabay stok klibi döneminden kalma, `@deprecated`. Hiçbir yerden import edilmiyordu (beyaz tahta onun yerini aldı). |
| `src/llm/geminiClient.js` | 69 | `llm/provider.js` kendi Gemini çağrısını yapıyor; bu dosya hiç kullanılmıyordu. |
| `src/utils/DockerRunner.ts` + `tsconfig.json` | 115 | JS projesinde TS kalıntısı; sadece bu dosya için vardı, kullanılmıyordu. |
| `WhiteboardVideoAgent.planSceneChain()` + `planScenes()` + `normalizeSceneId()` | 187 | `planCompositions()` bunların yerini aldı; ikisi de ölü koddu. |
| `config.pixabayApiKey`, `.env` içindeki `PEXELS_API_KEY` | — | Stok klip yolu kalktı, anahtar işlevsizdi. |
| `autoVideo.js` içindeki kopya hat kodu | ~120 | `src/pipeline/shortPipeline.js`'e taşındı. |

## 2. Düzeltilenler

1. **Tek üretim hattı** — `src/pipeline/shortPipeline.js`.
   `npm run auto-video` ve `npm start` (Telegram/YouTube botu) artık **aynı** hattan geçiyor.
   Önceden bot yolu araştırma, görsel üretimi ve vision doğrulaması olmadan çalışıyordu;
   yani bottan çıkan video CLI'den çıkandan belirgin şekilde kötüydü. Fark kapandı.
2. **Metin yardımcıları tek yerde** — `src/utils/text.js` (`cleanText`, `countWords`,
   `splitSentences`, `tokenSet`, `similarity`). Bu fonksiyonlar 3 ayrı dosyada kopyaydı;
   `splitSentences` sürümlerinden biri Türkçe kısaltmaları (`vb.`, `Dr.`) yanlış bölüyordu.
   Artık tek, doğru sürüm kullanılıyor.
3. **`TTS_RATE` ortam değişkeni** — ses hızı koda gömülü `+20%` yerine `.env`'den geliyor.
   `TTS_WORDS_PER_SECOND` ile birlikte süre hesabı tutarlı kalıyor.
4. **Test altyapısı** — `npm test` (`node --test`), 14 test: soyut kelime yakalama,
   kaynak dışı sayı reddi, tekrar tespiti, etiket/yarım cümle temizliği, kelime
   zamanlarından sahne süresi, etiket üretimi.
5. **README gerçeklerle hizalandı** — içinde hâlâ "TypeScript ile yazılmış", "45-60 saniye",
   "131-171 kelime", `visual_prompt`, `--no-review`, "115 kelime" gibi v5 öncesi bilgiler vardı.
   Ayrıca var olmayan bir "TypeScript kod üretme/derleme" akışı anlatılıyordu; kaldırıldı.
6. **Küçük temizlik** — `config.js` girintisi, `scene.visualPrompt` yazım hatası (sahne
   dökümünde çizim tarifi hep `-` görünüyordu), `docs/cizim-mantigi.md` içindeki eski satır
   numaraları.

## 3. Ajan yapısı: kalsın mı?

Kısa cevap: **yapı sorun değildi, görev çakışmasıydı — o da bitti.** Ajan sayısı fazla
görünüyor ama çoğu ince ve tek iş yapıyor.

| Ajan | Satır | Rol | Karar |
|---|---|---|---|
| `TrendAgent` | 261 | Google Trends TR + RSS + yedek liste, `history.json` ile tekrar engeli | **kalır** (çekirdek) |
| `ResearchAgent` | 251 | Wikipedia TR+EN → kaynak metin → doğrulanmış olgular | **kalır** |
| `ScriptAgent` | ~780 | Plan → sahne sahne senaryo → doğrulama → editör geçişi | **kalır**, bölünebilir (aşağıda) |
| `ImageAgent` | 309 | Sahne başına illüstrasyon + vision onarım döngüsü | **kalır** |
| `VisionAgent` | 190 | Görsel ↔ cümle puanı | **kalır** |
| `VoiceAgent` | 135 | edge-tts + kelime zamanları + SRT | **kalır** |
| `WhiteboardVideoAgent` | ~770 | Zaman çizelgesi, kare render orkestrasyonu, ffmpeg | **kalır** (en şişkin dosya) |
| `QualityAgent` | 70 | ffprobe ile süre/ses kontrolü | **kalır** (ucuz, işe yarıyor) |
| `ManagerAgent` | ~100 | Telegram onayı + YouTube yükleme akışı | **opsiyonel** (aşağıdaki karar) |
| `TelegramAgent` / `YouTubeAgent` | 68 / 57 | Bot + OAuth yükleme | **opsiyonel** (anahtarsız pasif) |
| `ReviewerAgent` | 28 | `--review` turu | kalır |
| `DeveloperAgent` | 9 | 3 başarısız denemeden sonra hata yorumu | kalır |

**Sadeleştirme önerisi (istersen):** Telegram/YouTube akışını tamamen çıkarırsak
`ManagerAgent`, `TelegramAgent`, `YouTubeAgent`, `storage.js`, `index.js` ve üç npm
bağımlılığı (`node-telegram-bot-api`, `googleapis`, `node-cron`) düşer: ~350 satır + 3
bağımlılık. Otomasyonu `npm run auto-video` + Windows Görev Zamanlayıcı ile yaparsın.
Karşılığında "telefondan onaylayıp YouTube'a atma" yeteneğini kaybedersin.

**Ayrıca ayrılması iyi olur (yapılmadı):** `ScriptAgent` 780 satır. İçindeki doğrulama
fonksiyonları (`validateScript`, `checkGrounding`, `findAbstractWords`, `dedupeScenes`)
`src/agents/scriptRules.js` dosyasına taşınırsa üretim promptları ile kurallar ayrışır —
bakımı kolaylaşır. Aynı şey `WhiteboardVideoAgent` (zaman çizelgesi yardımcıları
`src/whiteboard/timeline.js`'e) için de geçerli.

## 4. Öncelikli iyileştirmeler (etki / emek)

| # | İş | Etki | Emek |
|---|---|---|---|
| 1 | **Görsel sağlayıcıyı açmak** (`IMAGE_PROVIDER=gemini` ya da yerel Flux) | Çok yüksek: videonun görünümü tamamen değişir | 5 dk (kod hazır) |
| 2 | Vision eşiğini 7 → 8 çekip `IMAGE_MAX_ATTEMPTS=4` | Orta: daha az alakasız görsel, +maliyet | 1 dk (`env`) |
| 3 | **Kapak karesi (thumbnail)**: ilk kareye büyük başlık + 1 görsel | Yüksek: Shorts'ta tıklanma | 2-3 saat |
| 4 | Görsel tutarlılık: sabit palet + 2× upscale + unsharp | Orta-yüksek: profesyonel görünüm | 1 saat |
| 5 | Altyazıda **aktif kelime vurgusu** (karaoke) | Orta: izlenme süresi | 3 saat |
| 6 | Telifsiz arka plan müziği + `sidechaincompress` (ses ducking) | Orta: video "boş" hissini bitirir | 2 saat + ses dosyası |
| 7 | Trend kalite filtresi (başlık uzunluğu, tıklanabilirlik, İngilizce→TR çeviri) | Orta: konu isabeti | 2 saat |
| 8 | Render hızlandırma: kareleri paralel üretmek, `FRAME_FORMAT=jpg` kalite ayarı | Orta: 30-40 sn kazanç | 2 saat |
| 9 | A/B: aynı senaryodan iki görsel stil (marker / bold flat) | Deneysel | 1 saat |
| 10 | `scenes.py` (1223 satır) emekliliği — **yalnızca görsel üretimi kalıcı açılırsa** | Kod tabanı küçülür | 30 dk |

> Not: 10. maddeyi şimdi yapmadım. `IMAGE_PROVIDER` boşken tek çalışan yol o; silmek
> anahtarsız kullanımı komple bozar.

## 5. Görsel menüsü (paylaşmak istediğin kısım)

### Sağlayıcı seçenekleri

| Seçenek | Kalite | Maliyet | Not |
|---|---|---|---|
| **Google Imagen 3** (`imagen-3.0-generate-002`) | Yüksek, çizgi sanatında temiz | ~$0.03/görsel → video ~$0.4 | Aynı anahtar vision doğrulaması için de çalışır (tek anahtar) |
| **OpenAI gpt-image-1** | En yüksek detay | ~$0.04-0.08/görsel | Türkçe metin yazma eğilimi var; `no text` şart |
| **fal.ai Flux.1-schnell** | Yüksek, hızlı (~1 sn) | ~$0.003/görsel → video ~$0.05 | Custom sağlayıcı ile bağlanır (`IMAGE_API_URL`) |
| **Yerel Flux.1-schnell (mflux / ComfyUI)** | Yüksek | Ücretsiz | 8-12 GB VRAM; CPU'da sahne başına dakikalar |
| **Yerel SDXL-Turbo** | Orta | Ücretsiz | Daha düşük VRAM, stil tutarlılığı zor |

Benim önerim: **Imagen 3** ile başla (tek anahtar, vision dahil), kalite/maliyet dengesi
tutarsa kal; hacim artarsa fal'a geç (20 kat ucuz, aynı kod).

### Prompt iyileştirmeleri (denenmeye hazır)

1. **Tek konu kuralı**: `"one single subject, one action"` — çok nesneli sahnelerde model
   dağıtıyor. `image_prompt`'u 6-16 kelimede tutup nesne sayısını 2-3 ile sınırlamak
   (şu an öyle) korunmalı.
2. **Palet kilidi**: `"only black outline + yellow (#F2B705), blue (#3F7FBF), orange
   (#E07B39)"` — video boyunca renk tutarlılığı sağlar. Şu an stil metninde renk adları var,
   hex eklemek marka hissi verir.
3. **Çizgi kalınlığı**: `"uniform thick 8px black marker outline, no thin hatching"` —
   upscale edilince ince taramalar bulanıklaşıyor.
4. **Kağıt dokusu**: görseli üretirken düz beyaz istemek (şu an öyle), dokuyu render'da
   eklemek (`ink.py` zaten grain ekliyor). Modelin kendi dokusuyla çakışmıyor.
5. **Varyant**: `IMAGE_STYLE_PROMPT` ile iki stil dene:
   - `marker-doodle` (mevcut),
   - `bold-flat`: `"bold flat vector style, 6px black outline, no shading, poster-like"`.

### Ücretsiz kalite artışı: 2× upscale

Üretilen görseller 1024×1536 geliyor, videoda ~930 px genişliğe oturuyor. `render.py`
içinde LANCZOS ile 1.5-2× büyütüp hafif `unsharp` uygulamak çizgileri belirginleştirir
(maliyet: sahne başına ~20 ms). İstersen bunu bu turda ekleyebilirim.

## 6. Karar bekleyen 3 şey

1. **Bot akışı kalsın mı?** (Telegram onayı + otomatik YouTube yükleme) — kalırsa yukarıdaki
   sadeleştirme yapılmayacak; çıkarsa ~350 satır ve 3 bağımlılık düşer.
2. **Görsel sağlayıcı hangisi?** Gemini/Imagen (kolay, ücretli), fal/Flux (çok ucuz),
   yerel Flux (ücretsiz, GPU ister).
3. **Bütçe**: video başına ~$0.4-0.7 kabul mü? Değilse fal (~$0.05) veya yerel yol.

Bu üçüne cevap verirsen sıradaki turu ona göre planlarım: 1 numaralı iyileştirme
(görsel sağlayıcı) + kapak karesi + upscale'i tek turda bitirebiliriz.
