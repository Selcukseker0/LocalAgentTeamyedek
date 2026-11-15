# Çizim mantığı — bir sahne nasıl çiziliyor?

Bu dosya, çizimlerin nereden geldiğini ve neden "rastgele ikon" gibi göründüğünü anlatır.
Başka bir modele (Claude vb.) danışmak için dosyanın sonundaki **brief**'i olduğu gibi kopyalayabilirsin.

## 0. Nerede kaldık (v5)

Teşhis doğruydu: sorun görsel modelinde değil, **cümlenin çizilebilir olmaması** ve
**görselin doğrulanmaması**. v5'te şunlar eklendi:

| Adım | Dosya | Ne yapıyor |
|---|---|---|
| Kaynak toplama | `src/agents/ResearchAgent.js` | Wikipedia TR + EN → kaynak metin → 6-8 somut olgu (kaynakta olmayan elenir) |
| Çizilebilir script | `src/agents/ScriptAgent.js` | `visual_objects` alanı, soyut kelime yasağı, 8-14 kelime, tek bilgi |
| Editör geçişi | `ScriptAgent.critiqueScript()` | 1-10 puan; `SCRIPT_MIN_SCORE` altındaysa yeniden yaz |
| Görsel + onarım | `src/agents/ImageAgent.js` | prompt = stil + `image_prompt` + nesneler; aynı görsel çıkarsa yeni kompozisyon |
| Vision doğrulama | `src/agents/VisionAgent.js` | görsel + cümle → puan + eksik nesneler → prompt düzelt → yeniden üret |

Katalog yolu **hâlâ yedek**: anahtar yoksa veya görsel üretilemezse video durmuyor.

## 1. İki ayrı çizim yolu var

```
cümle ──► IMAGE_PROVIDER dolu mu?
           ├─ EVET → ImageAgent → PNG (her sahne için ayrı illüstrasyon)
           │        └─► render.py: ImageSceneRenderer (maske ile kontur açma + boyama)
           └─ HAYIR → planCompositions → katalogdan nesne seçimi (57 sabit doodle)
                    └─► render.py: SceneRenderer (sabit stroke listeleri)
```

`.env` içinde `IMAGE_PROVIDER` boşsa **ikinci yol** çalışır. Senin videolarında görünen çizimler bu yol.
Yani "AI çizim yapmıyor", **hazır 57 doodle'dan seçip yerleştiriyor**.

## 2. Katalog yolu: neye göre çiziyor?

### a) Nesne seçimi (LLM)
`WhiteboardVideoAgent.planCompositions()` (dosya içinde ara)

Modele şu prompt gider (özet):

> "Her cümle için **katalogdan 1-3 nesne** seç ve sayfaya yerleştir. Cümlede anlatılan OLAYI
> göster… Aynı nesneyi her cümlede tekrarlama… x ve y 0-1 arası, size 0.25-0.6"

Katalog = `SCENE_HINTS` (`WhiteboardVideoAgent.js` başı) — **57 nesne**:

`egyptian_vase, honey_pot, milk_bread_honey, water_drop, bacteria_honey, question, clock, sun,
heart, money, house, book, check, cross, bee, phone, chart, shield, flame, factory, cloud_rain,
sky, rainbow, planet, coffee, lightbulb, battery, tree, car, rocket, brain, map, thermometer,
ice, salt, eye, ear, key, ladder, bridge, boat, airplane, calendar, moon, magnet, leaf, road,
person, two_people, arrow_up, arrow_down, bubble, star, magnifier, gear, shopping, generic`

Model çıktısı: `{"scenes":[{"index":1,"objects":[{"type":"ice","x":0.42,"y":0.58,"size":0.45}]}]}`

**Kritik nokta:** model bir şey "çizmiyor", sadece **bu 57 etiketten birini seçiyor**. Cümle
katalogda yoksa (ör. "Zenit'in gerçek adı", "ismi nereden geliyor") en yakın genel doodle'a
düşüyor: `question`, `eye`, `magnifier`, `clock`, `book`. Bu yüzden çizim cümleyi anlatmıyor,
"konuyla ilgili rastgele bir simge" gibi duruyor.

### b) Model başarısız olursa (yedekler)
`planCompositions` sırasıyla:
1. `scoreScenes(cümle + çizim tarifi)` → `SCENE_KEYWORDS` sözlüğünde **alt dizgi** eşleşmesi.
   Ör. "bal" geçen her cümle → `honey_pot` ya da `bee`.
2. `pickAnchor(cümleler, konu)` → konu kelimesinin en sık eşleştiği sahne.
3. Hiçbiri yoksa → `question`, o da kullanıldıysa `book`.

### c) Çeşitlendirme (rastgeleliğin kaynağı)
- `planCompositions`: art arda aynı nesne kümesi gelirse **ana nesne "ilgili sahne" ile değiştirilir**
  (`relatedScene`), yani anlamdan bağımsız bir ikame.
- `planCompositions`: art arda aynı nesne kümesi gelirse `relatedScene` ile ana nesne değiştirilir.
- (v6'da silinen eski yol — `planScenes` — bir nesne 2 kez kullanılırsa zorla başkasına atlardı.)

Bu iki kural yüzünden bazen cümleyle hiç ilgisi olmayan bir nesne sahneye giriyor.

### d) Çizimin kendisi
`src/whiteboard/scenes.py` — her nesne **elle yazılmış sabit koordinat listesi**. Örnek:

```python
def scene_ice():
    top   = [(420, 700), (660, 640), (820, 720), (580, 790)]
    left  = [(420, 700), (580, 790), (580, 1080), (420, 990)]
    right = [(580, 790), (820, 720), (820, 1010), (580, 1080)]
    return [_fill_poly(top, (214,238,248)), _poly(top) @ BLACK 12, ...]
```

Yani çizim = elips / dikdörtgen / çokgen / bezier noktaları. Renderer bu noktaları sırayla
"kalem darbesi" gibi çizer, her darbeye 2 px titreşim (`_jitter`) ekler, el sprite'ı darbe ucunu
takip eder. **Nesne şekli sabit**; sadece konum/boyut/renk sırası değişir.

Sonuç: sahne = sayfaya serpiştirilmiş 1-3 **genel simge**. Tek bir "kompozisyon" (ör. bir
insanın buzu eritmesi) hiç üretilmiyor, çünkü katalogda böyle bir sahne yok.

## 3. Görsel üretimi yolu (kaliteli olan)

`IMAGE_PROVIDER=gemini|openai|custom` ise:
1. `ScriptAgent` her sahneye `image_prompt` yazar (cümledeki nesneler + olay).
2. `ImageAgent` (Imagen / gpt-image-1 / kendi API'n) → `images/scene_XX.png`.
3. `ImageSceneRenderer` görseli kontur + renk katmanına ayırır; kontur sahne süresinin %68'inde
   yukarıdan aşağıya maskeyle açılır (el kalemi sınırı takip eder), kalan %24'te renk fırçayla dolar.
4. Görsel üretilemezse o sahne katalog yoluna düşer (video durmaz).

Bu yol kod olarak hazır ve test edildi; **tek eksik API anahtarı**.

## 4. Kalan karar: hangi görsel sağlayıcı?

İki yol hazır, seçim maliyet/kalite meselesi. (v5 ile script ve doğrulama katmanı ikisinde de aynı.)

| Yol | Anahtar/kurulum | Kalite | Maliyet | Durum |
|---|---|---|---|---|
| **A. Imagen / gpt-image** | `GEMINI_API_KEY` / `OPENAI_API_KEY` | Yüksek — cümleye özel illüstrasyon | ~$0.02-0.05/görsel → video başına ~$0.3-0.7 | **kod hazır** |
| **B. Yerel difüzyon** (Flux schnell / SDXL) | Model indirme | Yüksek-orta | Ücretsiz | kurulmadı |
| **C. Prosedürel DSL** (LLM stroke üretsin) | Yok | Orta | Ücretsiz | kurulmadı |
| **D. Kataloğu büyütmek** | — | Düşük | — | çıkmaz sokak (denendi) |

Eski karşılaştırma tablosu (referans olsun diye):

| Yol | Anahtar/kurulum | Kalite | Maliyet | Emek |
|---|---|---|---|---|
| **A. Hazır (Imagen / gpt-image)** | `GEMINI_API_KEY` veya `OPENAI_API_KEY` | Yüksek — cümleye özel illüstrasyon | ~$0.02-0.05 / görsel → video başına ~$0.3-0.7 | Sıfır (kod hazır) |
| **B. Yerel difüzyon** (Flux.1-schnell / SDXL, ComfyUI veya mflux) | Model indirme, Python | Yüksek-orta | Ücretsiz | Orta; 8-12 GB VRAM, CPU'da yavaş |
| **C. Prosedürel "çizim DSL"i** — LLM doğrudan stroke/path JSON'u üretsin | Yok | Orta; stil korunur ama şekiller kaba | Ücretsiz | Yüksek: şema + doğrulayıcı + onarım döngüsü |
| **D. Kataloğu büyütmek** | — | Düşük | Ücretsiz | **Çıkmaz sokak** (denendi, reddedildi) |

C seçeneği teknik olarak şöyle olurdu: modele `{"strokes":[{"pts":[[0.1,0.2],...],"color":"black","width":8}]}`
gibi 0-1 normalize koordinat ürettirilir; `render.py` bunları `SceneRenderer`'a verir. Risk:
7B yerel model koordinat üretmede zayıf → şekiller tanınmaz; büyük model + katı şema + 2-3 kez
onarım gerekir.

## 5. Claude'a yapıştırılacak brief

```
Türkçe YouTube Shorts üreten bir Node.js + Python hattım var. Sorun: sahnelerdeki çizimler
cümleyi anlatmıyor, sayfaya serpiştirilmiş genel simgeler gibi duruyor.

Mimari:
1) src/agents/TrendAgent.js — konu seçer (Google Trends TR + RSS, geçmiş tekrarını engeller).
2) src/agents/ScriptAgent.js — 30-45 sn senaryo; her sahne {narration, image_prompt}.
3) src/agents/ImageAgent.js — IMAGE_PROVIDER varsa sahne başına PNG üretir
   (openai: gpt-image-1, gemini: imagen-3.0-generate-002, custom: POST {prompt}).
4) src/agents/WhiteboardVideoAgent.js:468 planCompositions() — görsel yoksa LLM'e
   "katalogdan 1-3 nesne seç" dedirtir. Katalog = 57 sabit doodle (SCENE_HINTS, satır 26).
   Yedek: SCENE_KEYWORDS alt-dizgi eşleşmesi (scoreScenes), sonra pickAnchor, sonra 'question'/'book'.
   Ek olarak art arda aynı nesne gelirse relatedScene ile zorla değiştirilir (rastgele görünüm).
5) src/whiteboard/scenes.py — her doodle elle yazılmış sabit koordinat listesi
   (elips/dikdörtgen/çokgen/bezier), 1080x1920 tuval.
6) src/whiteboard/render.py — SceneRenderer stroke'ları sırayla çizer, _jitter ile 2px titreşim,
   el sprite'ı kalem ucunu izler; ImageSceneRenderer ise üretilen PNG'yi kontur+renk katmanına
   ayırıp maske ile açar (LINE_PHASE=0.68, COLOR_PHASE=0.24), autocrop_white ile kenar boşluğu kırpar.
7) Ses: edge-tts (tr-TR-AhmetNeural), kelime zamanları SRT'ye; ffmpeg kareleri sesle birleştirir.

Kısıtlarım:
- Ücretli API zorunlu olmamalı; anahtar yoksa sistem çalışmaya devam etmeli (yerel Ollama qwen2.5:7b).
- Stil: beyaz kâğıt, siyah keçeli kalem konturu + sarı/mavi/turuncu sade dolgu, gerçek el kalemi tutuyor.
- Sahne = tek net kompozisyon (cümledeki olay), ekranı doldurmalı, minik ikon değil.
- Windows + Node.js + Python 3.15 + Pillow ortamı.

Şu üç yolu karşılaştır ve somut dosya/plan öner:
A) IMAGE_PROVIDER ile gerçek görsel üretimi (kod hazır) — maliyet/kalite dengesi, hangi model,
   hangi prompt, kaç sahne, önbellek stratejisi, başarısızlık yönetimi.
B) Anahtarsız yerel difüzyon (Flux schnell / SDXL; ComfyUI veya mflux) — Windows'ta kurulum,
   VRAM gereksinimi, sahne başına süre, stil tutarlılığı (aynı seed + stil prompt).
C) LLM'in doğrudan stroke/path JSON'u ürettiği prosedürel DSL — şema tasarımı, doğrulayıcı,
   onarım döngüsü, 7B modelde başarı şansı; hangi model minimum gerekli.

Ayrıca: mevcut katalog yolunu tamamen kaldırmadan "kalite tabanı" nasıl yükseltilir?
(ör. sahne başına nesne sayısı, kompozisyon şablonları, metin etiketi ile birlikte çizim)
Somut kod değişikliği öner, dosya adları ve fonksiyon imzalarıyla.
```
