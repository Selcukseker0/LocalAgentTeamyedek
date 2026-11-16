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

## 6. Bu turda uygulananlar (görsel cila + ücretsiz sağlayıcı)

Kararların: bot akışı **kalıyor**, bütçe **yok**, odak **görsel cila**. Buna göre:

| İş | Durum | Nerede |
|---|---|---|
| Ücretsiz görsel sağlayıcı (`IMAGE_PROVIDER=pollinations`) | **eklendi** | `ImageAgent.pollinationsImage()` — anahtarsız, Flux tabanlı, `IMAGE_REQUEST_DELAY_MS` ile oran sınırına saygı |
| Kontur keskinleştirme | **eklendi** | `render.py`: resize sonrası `UnsharpMask`, `IMAGE_SHARPEN` (0-2) |
| Kontur kalınlaştırma (marker hissi) | **eklendi** | `render.py`: `_thicken_line_layer()` `MaxFilter`, `IMAGE_LINE_BOOST` (0-2) |
| Sabit palet + kalın çizgi promptu | **eklendi** | `ImageAgent.DEFAULT_STYLE`: sarı `#F2B705`, mavi `#3F7FBF`, turuncu `#E07B39`, "uniform thick marker outlines, no thin hatching" |
| YouTube kapak karesi | **eklendi** | `src/whiteboard/cover.py` + `WhiteboardVideoAgent.makeCover()` → `cover.jpg` (1080x1920) |
| Yedek (anahtarsız) yolda sayfa doluluğu | **eklendi** | `scenes.py`: `compose` nesne boyutu alt sınırı 0.34→0.40, varsayılan 0.62→0.66, kenar clamp 0.16-0.84 |
| Ölçekle birlikte çizgi kalınlığı | **eklendi** | `scenes.py`: `_fit_scene` `width_scale = 0.9-1.8` |
| Planlayıcı promptunda boyut aralığı | **güncellendi** | `planCompositions`: `size` 0.45-0.75 («sayfa boş kalmasın») |

Doğrulama: `npm test` 14/14; paylaşılan hat sahte Pollinations yanıtıyla uçtan uca
çalıştırıldı (12 sahne, 30 görsel isteği, `cover.jpg` üretildi, 29.9 s video).
Kareler ve kapak gözle kontrol edildi: çizgiler v5'e göre belirgin kalın,
kapakta başlık sarı bantta okunur.

## 7. Karar bekleyen 3 şey

1. ~~Bot akışı kalsın mı?~~ → **kalıyor** (pipeline'a bağlı, kalitesi CLI ile aynı).
2. ~~Görsel sağlayıcı hangisi?~~ → **şimdilik ücretsiz yol**: `pollinations`. Kalite yetmezse
   fal (~$0.05/video) veya yerel Flux; kod ikisine de hazır (`custom` sağlayıcı).
3. **Sıradaki iş**: kapak/altyazı/müzik cilası mı, yoksa hız + sağlamlık mı?

Bu üçüne cevap verirsen sıradaki turu ona göre planlarım: 1 numaralı iyileştirme
(görsel sağlayıcı) + kapak karesi + upscale'i tek turda bitirebiliriz.

## 8. Bu turda uygulananlar ("her şeyi yap", bütçe yok)

Önceki turun açık listesi tek turda kapatıldı. Hepsi **ücretsiz ve anahtarsız**
varsayılanla çalışır.

| İş | Durum | Nerede |
|---|---|---|
| Karaoke altyazı (konuşulan kelime sarı vurgulu) | **eklendi** | `subtitles.py`: `attach_word_timings()` + `SubtitleRenderer(words=...)`; eşleşme oranı <0.6 olan cümle otomatik düz altyazıya döner, `SUBTITLE_KARAOKE=0` kapatır |
| Kelime zamanlarının render'a taşınması | **eklendi** | `WhiteboardVideoAgent` → `voice_words.json` → `renderFrames(..., wordsPath)` → `render.py --words` |
| Arka plan müziği + otomatik kısma (ducking) | **eklendi** | `WhiteboardVideoAgent.encodeVideo()`: `sidechaincompress` ile konuşurken müzik ~%84 kısılır, giriş/çıkış fade'i; `MUSIC_PATH` / `assets/music/` / `MUSIC_VOLUME` |
| Ücretsiz varsayılan müzik | **eklendi** | `src/whiteboard/assets/music/paper_plucks.mp3` (12 s, kendi üretimimiz, telifsiz, 142 KB) |
| Paralel kare çizimi | **eklendi** | `render.py`: `RENDER_WORKERS` / `--workers`, sahne sınırlarından bölme, tohumlar sahne numarasına bağlı → çıktı aynı; hata olursa seri çizime döner |
| Trend adaylarını puanlama + zayıf konuyu reddetme | **eklendi** | `TrendAgent.scoreTopic()` (somutluk/soru/sayı + ceza: soyut, magazin, aşırı uzun); adaylar puana göre sıralanıp modele öyle verilir |
| Süre kontrolünün 30-45 sn'ye çekilmesi | **düzeltildi** | `QualityAgent`: eski 35-62 sn bandı 25-55 sn'ye, uyarı bandı 28-48 sn'ye alındı; altyazı parça sayısı kontrolü eklendi |

Doğrulama: `npm test` **18/18** (4 yeni trend puanlama testi). Sahte ses ajanıyla
uçtan uca çalıştırıldı: 12 sahne / 29.9 s / 898 kare, `cover.jpg` üretildi, müzik
logda `paper_plucks.mp3, ses 16%` olarak göründü, çıktı videosunda tek AAC ses
akışı (konuşma + müzik karışımı) var. Karelerden alınan altyazı bandında aktif
kelimenin sarı bant + koyu yazıyla vurgulandığı gözle doğrulandı.
Paralel render testi (6 sahne, 360 kare): seri 4.07 s → 3 işçi 3.32 s (başlatma
dahil); seri/paralel kareler arasındaki en büyük fark 3/255 (JPEG yuvarlaması,
gözle ayırt edilemez).

Kalan (bilinçli olarak yapılmadı): A/B stil denemeleri (tek stil oturdu, veri
toplamadan bölmek riskli) ve `scenes.py` kataloğunun emekliye ayrılması (anahtarsız
yedek yol olarak değerli). `ScriptAgent` / `WhiteboardVideoAgent` dosya bölünmesi
de davranış değiştirmediği için ertelendi.

## 9. Gerçek çalıştırma hatası sonrası düzeltmeler (Windows, qwen2.5:7b)

Kullanıcının ilk gerçek denemesi **20 dakika sonra hata** verdi:
`Senaryo üretilemedi (7 cümle, 78 kelime)`. Kök nedenler ve yapılanlar:

| # | Kök neden | Düzeltme |
|---|---|---|
| 1 | **Araştırma yanlış maddeye gitti**: "Buzun sırrı ne?" → Wikipedia "Mehmed Selim **Sırrı** Paşa" maddesi. Üç "olgu" bir Osmanlı paşası hakkındaydı, senaryo ise buzdan yazılmaya çalışıldı | `ResearchAgent`: `buildSearchQuery()` (soru/süs kelimeleri + Türkçe ekler atılır), `pickBestArticle()` (ilk sonucu körlemesine almaz; ana kelime madde/özet içinde geçmeli), `relevanceScore()` (gövde karşılaştırması: **bal ≠ balık**). Örtüşme `RESEARCH_MIN_MATCH` altındaysa araştırma atlanır |
| 2 | **Uzun cümleler atılıyordu**: model 17-38 kelime yazıyor, `checkSentence` 16 kelime üstünü "çok uzun" diye siliyordu ("çok uzun (26)×1, (28)×1, (31)×1" satırları) | `splitLongSentence()`: virgül/bağlaç sınırından bölme, bağlaç korunur (`… oluşur, bu yapı sayesinde …`). `sanitizeScenes()` artık bölüyor, atmıyor |
| 3 | **Kısa cümleler de atılıyordu** ("çok kısa (4)×4") | Kısa cümle önceki cümleye virgülle eklenir; sonda kalan parça tek cümle olarak tutulur |
| 4 | **Sonsuz/uzun yeniden üretim**: 3 deneme × (plan + 2 bölüm + 3 ek tur) ≈ 20 dk, sonunda hata | `SCRIPT_BUDGET_SEC` (varsayılan 600 s), ek tur 3→2, "ilerleme yoksa dur" kontrolü |
| 5 | **Hatada çıktı yok**: 7 cümle/78 kelime elde varken akış hata verdi | `SCRIPT_FALLBACK_SCENES`/`SCRIPT_FALLBACK_WORDS` (6/55): kusurlu ama izlenebilir senaryo kabul edilir, uyarı basılır |
| 6 | **Grounding aşırı katı**: "1. sahne (0)" gibi 0-99 sayılar da halüsinasyon sayılıyor, `3.000` ile `3000` eşleşmiyordu | `canonicalNumber()` (binlik/ondalık normalizasyonu) + yalnızca `GROUNDING_MIN_NUMBER` (100) ve üzeri denetlenir |
| 7 | **Trend puanı "piramitleri" içindeki "mit"i magazin sayıyordu** | `\p{L}` sınırı: `mit` artık yalnızca tam kelimeyken ceza alır. "sır/sırrı/bilmece/hikayesi" başlıkları -2; kabul eşiği 2 → 3 |

Doğrulama (Ollama olmadan, sahte LLM ile gerçek akış):
- Aynı senaryo (7b'nin uzun cümleleri) artık **1. denemede** geçiyor: 8 sahne, 88 kelime, ~30 sn, **3 LLM çağrısı** (önce 12).
- Bütçe dolduğunda/denemeler tükendiğinde hata yerine uyarıyla video üretiliyor (7 sahne, 83 kelime, ~29 sn).
- Araştırma testleri gerçek olayı kapsıyor: "Buzun sırrı ne?" + "Sırrı Paşa" → **null**; "Buz" → seçilir; "bal" ≠ "balık".
- `npm test` → **27/27** (9 yeni test: `test/research.test.js`, `test/scriptSplit.test.js`).
- `npm run whiteboard-demo` → 46.2 s / 1386 kare / 8.4 MB video, render yolu bozulmadı.

## 10. "10 dakika bekliyorum, aynı hata" turu (Gemini + yavaşlık)

Kullanıcının logu: Gemini her çağrıda `TimeoutError` / `fetch failed` → Ollama'ya
düşüyor → 7b CPU'da araştırma 338 sn, plan 554 sn → video hiç çıkmıyor.

| Sorun | Düzeltme |
|---|---|
| Model adı emekliye ayrıldı (`gemini-2.0-flash` → 404 "use models/X") | `src/llm/gemini.js`: 404 gövdesindeki öneri otomatik benimsenir; yoksa model listesinden en yeni flash seçilir. `GEMINI_MODEL` boş bırakılabilir |
| Bağlantı hatasında istek asılı kalıyordu | `GEMINI_TIMEOUT_MS` (45 sn) + `AbortSignal.timeout`, ağ hatasında üstel bekleme ile `LLM_RETRIES` (2) tekrar |
| `fetch failed` nedeni görünmüyordu | Gerçek kod yazılıyor (ECONNRESET/ENOTFOUND/TimerError); Windows IPv6 takılmasına karşı `dns.setDefaultResultOrder('ipv4first')` |
| Gemini hatası → sessizce 10 dk yavaş model | `LLM_NO_FALLBACK` (0/1) + devre kesici (`LLM_BREAKER_FAILURES=2`): iki hatadan sonra kalan adımlar boşuna beklemez |
| Ollama çağrısı sonsuza kadar sürebiliyordu | `OLLAMA_TIMEOUT_MS` (5 dk) + `OLLAMA_SLOW_WARN_MS` (90 sn) yavaşlık uyarısı + 404'te "ollama pull …" mesajı |
| Senaryo için 5-6 LLM çağrısı (CPU'da ~20 dk) | `SCRIPT_SINGLE_PASS=auto`: ollama ile senaryo **tek çağrıda** yazılır (plan+bölüm+ek turlar yok) → ~5-7 dk |
| Yarım JSON | `parseJsonContent` kapanmamış `{`/`[` onarımı; `finishReason` loglanır |
| Vision modeli de eski adsız/300 token | `geminiVision` ortak istemciyi kullanır (model otomatik), `maxOutputTokens` 2048, JPEG/PNG/WebP mime sniffing |
| Uydurma "doğrulanmış bilgi" ("toz şeker yedirmek kanunen yasaldır") | `RESEARCH_FACT_OVERLAP` 0.30 → 0.45 + olgudaki sayı/tarihler kaynakta olmalı |
| `doctor` Gemini'yi hiç denemiyordu | Gerçek istek: modeli çözer, 1 cümle üretir, süreyi yazar; Ollama için 12 kelimelik hız ölçümü ve GPU ipucu |

Doğrulama: sahte `fetch` ile 7 senaryo (`test/provider.test.js`):
404 model önerisi → yeni adla devam; 503 → tekrar; ağ kopması → denemeler
tükenince Ollama; `LLM_NO_FALLBACK=1` → hata; devre kesici → Gemini hiç
denenmez; yarım JSON onarımı; model adı önerisi/model seçimi.
`npm test` → **34/34**. Tek geçiş simülasyonu: 13 cümlelik girdi → **1 LLM
çağrısı**, 11 sahne, 86 kelime, ~30 sn senaryo.

## 11. Gemini kotası dolduğunda (429) yeni yol

Kullanıcının anahtarı ücretsiz kota sınırına dayandı: `429 exceeded your current quota`.
Bağlantı ve model adı artık sorunsuz; engel yalnızca kota.

| İş | Durum | Nerede |
|---|---|---|
| Kota hatasını ayırt etme | **eklendi** | `doctor`: 429'da "Kota doldu (429) — bağlantı çalışıyor" + yeni anahtar/alternatif önerisi (internet/VPN önerisi kaldırıldı) |
| OpenAI uyumlu ücretsiz sağlayıcılar | **eklendi** | `provider.js`: `groq`, `openrouter`, `cerebras`, `together`, `lmstudio`, `llamacpp`, `custom` (`LLM_API_URL`). `LLM_API_KEY` + `LLM_MODEL` yeterli |
| `response_format` desteklemeyen sağlayıcı | **eklendi** | 400 alınca JSON modu olmadan tekrar dener |
| 429/5xx/ağ hatası | **eklendi** | `Retry-After`/üstel bekleme ile tekrar, `LLM_NO_FALLBACK` ve devre kesici aynı şekilde geçerli |
| Yavaş Ollama'da sessizlik | **eklendi** | `ollamaClient` artık `stream: true`; 5 sn'de bir `Ollama yazıyor… N karakter, X sn` satırı, sonunda parça/süre özeti |
| doctor'da özel sağlayıcı | **eklendi** | gerçek istek + model + URL + süre |

Doğrulama: `test/customProvider.test.js` (5 test) — hazır URL, `response_format`
400 → tekrar, 429 → tekrar, `LLM_MODEL` boş hatası, NDJSON akış birleştirme.
`npm test` → **39/39**.

Not: Groq/OpenRouter/Cerebras'ın gerçek uçlarına sandbox'tan erişilemiyor;
istek biçimi (OpenAI `/chat/completions`) sahte fetch ile doğrulandı, canlı
doğrulama kullanıcı makinesinde `npm run doctor` ile yapılacak.

## 12. ".env'i tamamen düzelt" turu

Kullanıcı `.env` dosyasının tamamını yapıştırdı ve "bunu tamamen düzelt" dedi.
Dosyada üretimi sessizce bozan satırlar vardı:

| Satır | Sorun | Sonuç |
|---|---|---|
| `GROUNDING_MIN_NUMBER=10cls` | `Number('10cls')` = `NaN` | uydurma-sayı kontrolü sessizce kapandı → "kaynakta olmayan sayı" videoya girdi |
| `GROUNDING_MIN_NUMBER=1` (ikinci kez) | tekrarlanan anahtar | son satır kazandı, eşik 1'e düştü (kontrol fiilen kapalı) |
| `LLM_PROVIDER=gemini` + sonra `=groq` | tekrarlanan anahtar | hangisinin geçerli olduğu belirsiz |
| `LLM_API_KEY=gsk_…X.  ` | sonda nokta + boşluk | 401; anahtar geçersiz |
| `LLM_MODEL=…   ` | sonda boşluk | model adı bulunamaz |
| `VISION_MODEL=gemini-3.8-flash` | uydurma model adı | 404 / vision sessizce atlanır |
| `SCRIPT_SINGLE_PASS`, `IMAGE_429_RETRIES`, `LLM_API_TIMEOUT_MS`, `RESEARCH_FACT_OVERLAP` | hiç yok | tek geçiş kapalı (yavaş), 429'da tekrar yok |

| İş | Durum | Nerede |
|---|---|---|
| `.env` doğrulayıcı | **eklendi** | `src/utils/envCheck.js` — `validateEnvFile()` / `summarizeIssues()`; sayı biçimi + aralık, tekrarlanan anahtar, sonda boşluk/nokta, bilinmeyen sağlayıcı |
| doctor | **eklendi** | `.env içeriği` satırı: temizse ✅, hata varsa ❌ + düzeltme önerisi |
| doctor | **eklendi** | `Görsel doğrulama` satırı: vision anahtarı yok ya da vision=gemini + birincil≠gemini ise uyarı (kota ayrı) |
| üretim öncesi denetim | **eklendi** | `autoVideo` `.env` hatalıysa **hiç başlamaz** (hızlı başarısız), uyarıları yazdırır |
| temiz dosya | **eklendi** | `.env.duzeltilmis`: tek geçiş, Groq birincil, `VISION_CHECK=0`, `GROUNDING_MIN_NUMBER=10`, sonda boşluk yok |
| testler | **eklendi** | `test/envCheck.test.js` (7 test) — `10cls`, tekrarlanan anahtar + satır numarası, sonda nokta/boşluk, bilinmeyen sağlayıcı, aralık dışı sayı, yorum/boş satır |

`npm test` → **46/46**. Doğrulama: bozuk `.env` ile `auto-video` çalıştırıldı →
4 sorun yazdırıp üretime girmeden çıktı; `.env.duzeltilmis` → `0 sorun`.

Güvenlik: iki anahtar sohbete düz metin yapıştırıldı → **iptal edilip
yenilenmeli** (console.groq.com/keys, aistudio.google.com/apikey).

## 13. "Anahtar 401 veriyor" — değer okunurken düzeltiliyor

`.env.duzeltilmis` yüklendikten sonra kullanıcı yeni Groq anahtarını sohbetten
satıra yapıştırdı; `doctor` ve `auto-video` **401 `invalid_api_key`** verdi.
Sebep: değerin sonunda kalan **nokta** (`LLM_API_KEY=gsk_...0mb6X.`). Dosya
"geçerli" görünüyordu, uyarı üretim akışını durdurmuyordu.

| İş | Durum | Nerede |
|---|---|---|
| Ayrıştırıcı (paylaşılan) | **eklendi** | `envCheck.js`: `parseEnvContent()`, `sanitizeEnvValue()` — tırnak, `# yorum`, boşluk, `_KEY/_TOKEN/_SECRET/_ID/_MODEL/_URL` alanlarında sondaki nokta |
| `.env` yükleyici | **eklendi** | `envLoad.js`: değerleri temizleyerek `process.env`'e yazar, `cleaned` raporu üretir, kabuk değerini ezmez, tek kez okur |
| Yükleme sırası | **eklendi** | `envBootstrap.js` giriş betiklerinin **ilk** import'u (`autoVideo`, `doctor`, `index`, `whiteboardDemo`, `youtubeAuth`, `initEnv`) — modül seviyesindeki `GROUNDING_MIN_NUMBER` gibi sabitler artık temiz değeri görür; `config.js` de yedek olarak çağırır |
| 401 hata mesajı | **eklendi** | `provider.js`: `anahtar reddedildi — LLM_API_KEY: 56 karakter · gsk_…b6X` (tam anahtar asla yazılmaz), 401/403 tekrar denenmez |
| `doctor` uyarı seviyesi | **eklendi** | uyarı artık ❌/✅ değil **⚠️ ** olarak basılır ve "sorun" sayılmaz; sonda `⚠️ N uyarı var (üretim çalışır)` |
| `doctor` anahtar biçimi | **eklendi** | `keyFormatWarning()`: groq `^gsk_[A-Za-z0-9]{40,}$`, openrouter `sk-or-v1-…`, gemini, anthropic |

Doğrulama: `.env`'e `LLM_API_KEY=gsk_TESTKEY0mb6X.   ` yazıldı →
`process.env.LLM_API_KEY === "gsk_TESTKEY0mb6X"`, `doctor` iki ⚠️ satırı yazdı
(`.env içeriği`, `LLM anahtarı`), `auto-video` uyarıyla **devam etti** (hata yok).
`npm test` → **54/54** (`test/envLoad.test.js` 7 test + 401 parmak izi testi).

## 14. Model adı 404 — "llama-3.3-70b-versatile does not exist"

Anahtar düzeldikten sonra (56 karakter, nokta temizlendi) sıradaki hata model adıydı:
Groq bu modeli kaldırmış, `404 code:"model_not_found"`. Sabit model adı yazmak
kırılgan: adlar aylar içinde değişiyor.

| İş | Durum | Nerede |
|---|---|---|
| 404 model → canlı liste | **eklendi** | `provider.js`: `GET {base}/models`, `pickModel()` ile sohbet modeli seçimi, istek **bir kez** yeni modelle tekrar (sonsuz döngü koruması: `modelSwaps`) |
| `LLM_MODEL` boş | **değişti** | Artık hata değil: model listeden seçilir (eski davranış: `LLM_MODEL tanımlı değil` hatası) |
| Model seçim kuralları | **eklendi** | ses/gömme/görsel/moderasyon modelleri elenir (`MODEL_BLOCK`); tercih sırası `gpt-oss-120b → llama-3.3-70b → llama-3.1-70b → qwen3-32b → kimi-k2 → llama-4-maverick → mixtral → llama-3.1-8b-instant → gemma` |
| Seçilen modeli hatırlama | **eklendi** | `currentModel()` — doctor gerçekten kullanılan modeli yazar |
| `doctor` mesajları | **düzeltti** | eskiden 404'te de "401 = anahtar geçersiz" yazıyordu; artık 401/403 → anahtar, 404 → model, 429 → kota ayrı öneri. Hata varsa sağlayıcının model listesi de basılır |
| Model listesi komutu | **eklendi** | `npm run models [-- groq]` → `src/scripts/listModels.js`, önerilen model `→` ile işaretli |
| `.env` örnekleri | **güncellendi** | `.env.duzeltilmis` + `.env.example`: `LLM_MODEL=` boş bırakılabilir (açıklamalı) |

Doğrulama: sahte Groq ucuyla (404 → `/models` → başarı) uçtan uca denendi:

```
❌ LLM (groq): API hatası (404): The model `llama-3.3-70b-versatile` does not exist…
✅ LLM (groq): openai/gpt-oss-120b · https://api.groq.com/openai/v1 · otomatik seçildi
⚠️  LLM_MODEL satırı: .env'deki LLM_MODEL sağlayıcıda yok → notepad .env → LLM_MODEL=openai/gpt-oss-120b
```

`npm test` → **55/55** (yeni: model boş → otomatik seçim, 404 → listeden değiştir).
