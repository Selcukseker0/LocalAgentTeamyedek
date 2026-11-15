# LocalAgentTeam

Ollama üzerinde yerel çalışan, TypeScript ile yazılmış deneysel çoklu ajan yazılım ekibi.

## Gereksinimler

- Node.js 20 veya üzeri
- npm
- Ollama
- Ollama üzerinde `qwen2.5:7b` veya yapılandırdığınız başka bir sohbet modeli

## Kurulum

```bash
npm install
npm run env:init     # .env dosyasını .env.example'dan oluşturur (varsa üzerine yazmaz)
ollama pull qwen2.5:7b
```

`.env` depoya **dahil değildir** (`.gitignore` içinde); her klonda bir kez
`npm run env:init` ile oluşturulur. Boş bırakılan alanların listesini de yazar.

Ollama uygulamasının/servisinin çalıştığından emin olun.

## Çalıştırma

```bash
npm start          # Telegram botu + otomatik zamanlanmış üretim
npm run auto-video # tek seferlik: trend konusu -> senaryo -> ses -> 45-50 sn Short
```

### Her çalıştırmada yeni konu, 45-50 saniyelik Short

`npm run auto-video` (veya `npm start`) her çalıştığında **kendi konusunu**
seçer; aynı senaryo ikinci kez üretilmez:

1. `TrendAgent` güncel başlıkları toplar (Google Trends TR, BBC Türkçe,
   r/todayilearned) ve Ollama'ya "en ilgi çekici, daha önce işlenmemiş konu"
   seçtirir. RSS/Ollama erişilemezse 26 konuluk yedek liste devreye girer.
2. Seçilen konu `data/history.json` içindeki `usedTopics` listesine **hemen**
   yazılır; sonraki çalıştırmalar bu konuyu (ve benzerini) reddeder. Son
   kategoriler de `usedCategories` içinde tutulur, mümkünse farklı kategori
   seçilir.
3. `ScriptAgent` senaryoyu **sahne sahne JSON** olarak üretir (küçük modeller
   130 kelimeyi tek yanıtta yazamadığı için parça parça):

   1. plan çağrısı → başlık, kanca, 4 bilgi, kapanış sorusu,
   2. bölüm 1 → kanca + soru + birinci bilgi (7 sahne),
   3. bölüm 2 → ikinci/üçüncü bilgi (6 sahne),
   4. gerekirse ek sahne çağrısı.

   Her sahne üç alanlıdır: `narration` (seslendirilecek tam cümle),
   `image_prompt` (o cümle için çizilecek sahnenin tarifi), `title`
   (1-3 kelimelik bant yazısı). Hedef **30-45 saniye** (87-128 kelime),
   her cümle tek fikir ve somut bilgi (sayı, isim, neden-sonuç) taşır. Modelin döndürdüğü metin **render'dan önce otomatik denetlenir**
   (aşağıya bakın); denetim geçmezse senaryo 2 kez daha yazdırılır.

4. Ses `edge-tts` ile üretilir ve **kelime kelime zaman damgası** alınır
   (`src/whiteboard/tts_timing.py`). Altyazı ve sahne geçişleri bu gerçek
   zamanlara oturur; sabit süreyle bölme yapılmaz. Whisper'a gerek yoktur,
   zamanlama doğrudan TTS motorundan gelir. Video gerçek ses süresine göre
   karelenir.

Senaryo, modele "cümle dizisi" olarak yazdırılır:

```json
{"scenes":[
  {"narration":"Seslendirilecek tam cümle.","visual_prompt":"buz küpünün üstünden su damlıyor","title":"3 KAT"},
  ...
]}
```

12-18 sahne, her cümle 6-20 kelime (hedef 8-14). Toplam süre 45-60 saniye
(~131-171 kelime). Model kısa yazarsa 3 tura kadar ek sahne istenir; 115
kelimenin altında kalırsa açık hata verilir (bozuk video üretilmez).

**Render'dan önce otomatik kontrol** (`validateScript`): her sahnede

- `narration` iki nokta, numara (`1)`, `3):`) veya etiket kelimesi
  (kanca/hook/sebep/kapanış) içermiyorsa,
- yarım kalmamışsa (`…`, virgül/bağlaç sonu) ve noktalaması varsa,
- kelime sayısı 5-20 aralığındaysa,
- aynı cümle iki kez geçmiyorsa (kelime örtüşmesi %70'in altında),

senaryo kabul edilir. Aksi hâlde sorunlar modele geri verilip yeniden yazdırılır
(2 deneme). Hâlâ bozuksa: sahne sayısı 8'in, kelime 115'in altındaysa üretim
açık hatayla durur; üstündeyse temizlenmiş hâliyle devam edilir.

### Senaryoyu hangi model yazıyor?

Varsayılan yerel Ollama (`qwen2.5:7b`). Daha iyi metin için bulut modeli
kullanılabilir:

```env
LLM_PROVIDER=gemini          # ollama | gemini | anthropic
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash
# veya
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-4-5
```

Bulut modeli hata verirse (anahtar yok, kota, ağ) akış durmaz; otomatik olarak
Ollama'ya düşer ve konsola uyarı yazar.

Senaryo kurgusu kısa video şablonuna göre istenir: **kanca (1-2 cümle) →
soru → sebep 1 → sebep 2 → kapanış sorusu**. Her cümle için ayrıca iki alan
gelir:

- `visual`: beyaz tahtaya çizilecek sahnenin 3-8 kelimelik tarifi
  (ör. "iki dil arasında köprü", "buz küpü eriyor"). Sahne seçiminde en
  belirleyici sinyal budur; tek kelime eşleşmesi değil, cümlenin **ne
  anlattığı** kullanılır.
- `title`: tahtanın üstüne el yazısıyla yazılacak 1-2 kelimelik vurgu.
  Modelin uydurduğu etiketler kabul edilmez: `title` sadece cümlenin içinde
  geçiyorsa kullanılır. Aksi hâlde etiket cümledeki **sayıdan** (`%40`,
  `3 KAT`) veya **konunun ana kelimesinden** üretilir; ikisi de yoksa bant
  çizilmez (anlamsız başlık yazılmaz). Aynı bant en fazla 2 sahnede görünür.

Hız kalibrasyonu: `tr-TR-AhmetNeural --rate=+20%` yaklaşık **saniyede 2.9
kelime** okuyor. Farklı ses/hız kullanırsanız `.env` içinde
`TTS_WORDS_PER_SECOND` değerini güncelleyin (örn. `2.6`).

```bash
# Konuyu kendiniz seçmek isterseniz:
node src/scripts/autoVideo.js --topic "Buz neden kaygandır?"
# İnceleme adımını atlamak için:
node src/scripts/autoVideo.js --no-review
```

Çıktı: `output/auto/<zaman damgası>-<konu>/shorts_whiteboard_<zaman damgası>.mp4`,
yanında `preview.jpg`, `run_info.json` ve `youtube_metadata.json`.

## Çizilebilir senaryo + görsel doğrulama

Görselin cümleyi anlatması iki şeye bağlı: **cümlenin çizilebilir olması** ve **görselin
doğrulanması**. İkisi de otomatik:

1. **Araştırma** (`src/agents/ResearchAgent.js`) — Wikipedia TR + EN maddesinden kaynak metin
   çekilir, model bu metinden 6-8 **somut olgu** çıkarır (sayı, yer, isim, neden-sonuç).
   Metinde karşılığı olmayan olgu elenir → **halüsinasyon yok**. `RESEARCH_ENABLED=0` ile kapanır.
2. **Çizilebilir script** (`ScriptAgent`) — her sahne `{narration, visual_objects, image_prompt}`.
   Kural: cümlede en az bir somut isim; `gizemli, ilginç, harika, inanılmaz, şaşırtıcı…` gibi
   soyut kelimeler **doğrulamada hata** sayılır. Cümle 8-14 kelime, 2-4 saniye.
3. **Editör geçişi** — render'dan önce ayrı bir LLM turu senaryoyu 1-10 puanlar (soyut kelime,
   tekrar, kaynak uyumu, hook). `SCRIPT_MIN_SCORE` (varsayılan 7) altındaysa bir kez daha yazılır.
4. **Görsel doğrulama** (`src/agents/VisionAgent.js`) — üretilen görsel + cümle modele gösterilir:
   `{"score": 7, "missing": [...]}`. Puan `IMAGE_VISION_PASS` altındaysa **eksik nesneler
   prompt'a eklenip yeniden üretilir** (en fazla `IMAGE_MAX_ATTEMPTS`, varsayılan 3).
   Aynı görsel iki sahnede çıkarsa (hash) yeni kompozisyon istenir.

```env
VISION_PROVIDER=gemini      # gemini | openai | custom (yerel)
VISION_MODEL=gemini-2.0-flash
IMAGE_MAX_ATTEMPTS=3
IMAGE_VISION_PASS=7
```

Vision anahtarı yoksa doğrulama atlanır, üretim devam eder.

## Sahne görselleri (Flux / Imagen / gpt-image)

Her cümle için **ayrı illüstrasyon** üretilebilir. Açmak için `.env`:

```env
IMAGE_PROVIDER=gemini            # openai | gemini | custom
IMAGE_MODEL=imagen-3.0-generate-002
GEMINI_API_KEY=...
# openai: IMAGE_PROVIDER=openai, IMAGE_MODEL=gpt-image-1, OPENAI_API_KEY=...
```

- Stil prompt'u sabittir: *hand-drawn black marker line art, whiteboard doodle
  style, centered composition, pure white background, simple flat marker
  coloring (yellow, blue, orange)*. `IMAGE_STYLE_PROMPT` ile değiştirilebilir.
- Prompt = sabit stil + `image_prompt` + `visual_objects` ("Must clearly show: ...").
  Stil ekinde **`no text`** vardır: görsel modeller Türkçe yazıyı bozuk üretiyor.
- Görseller `output/.../images/scene_01.png ...` olarak saklanır; aynı klasörde
  tekrar çalıştırılırsa yeniden üretilmez (önbellek).
- **Anahtar yoksa veya üretim başarısız olursa** video durmaz: o sahne için
  yerleşik çizim kompozisyonu kullanılır. Yani sistem ücretsiz de çalışır.
- `IMAGE_PROVIDER=custom` + `IMAGE_API_URL` ile kendi ucuz API'niz bağlanır
  (`POST {prompt}` → `{"image":"<base64>"}` veya `{"url":"..."}`).

Render tarafında her illüstrasyon **çiziliyormuş gibi** açılır:

1. Sahne süresinin ilk ~%68'inde siyah konturlar yukarıdan aşağıya maske ile
   açılır; el (şeffaf arka planlı sprite) açılma sınırını takip eder.
2. Kalan sürede renk katmanı soldan sağa fırça gibi süpürülür.
3. Görsel genişliğin ~%86'sını kaplar, üstte bant yazısı ve altta altyazı için
   boşluk bırakılır.

## Shorts video görünümü (beyaz tahta / keçeli kalem stili)

Videolar stok klip yerine **beyaz kâğıt üzerine keçeli kalemle çizim** olarak
üretilir: dikey 1080x1920, beyaz zemin, siyah marker çizgileri, seçici renk
dolguları (bal sarısı, süt mavisi, ekmek kahvesi) ve sağ alttan giren gerçek
bir el. Altyazılar ekranın altında koyu yarı saydam kutuda beyaz kalın yazıyla
gösterilir.

Akış:

1. `WhiteboardVideoAgent` senaryoyu cümlelere böler ve süreleri TTS kelime
   zamanlarından çıkarır (yoksa altyazı ipuçları, en son tahmini süre).
1b. `IMAGE_PROVIDER` açıksa `ImageAgent` her cümle için illüstrasyon üretir;
   üretilemeyen sahneler aşağıdaki kompozisyon yoluna düşer.
2. Her cümle için **1-3 nesnelik çizim kompozisyonu** planlanır: model cümleyi
   ve `visual_prompt`'u okur, katalogdan nesneleri seçip sayfaya yerleştirir
   (`{"type":"ice","x":0.42,"y":0.58,"size":0.45}`). Model yoksa anahtar
   kelimeden tek nesne üretilir; **boş sayfa bırakılmaz**, arka arkaya aynı
   kompozisyon gelmez.
3. `src/whiteboard/render.py` (Pillow) her sahneyi kare kare çizer. Çizim
   gerçek marker hissi verecek şekilde yapılır (`src/whiteboard/ink.py`):
   değişken uç kalınlığı ve basınç profili, uç birikmesi, darbeler arasında
   kalemin havada gezinmesi, kâğıt grain/lif dokusu ve vinyet, yarı saydam
   bantlı renk dolguları. El sahne başında kadraja girer, kalemi takip eder
   ve sahne sonunda kareyi terk eder. Altyazılar da karelere gömülür.
4. `ffmpeg` kareleri ses ile birleştirip zaman damgalı
   `shorts_whiteboard_YYYYMMDD-HHMMSS.mp4` dosyasını üretir; her çalıştırma
   kendi klasörüne yazar (`preview.jpg`, `run_info.json`, `frames/`).

### Gereksinimler

```bash
pip install Pillow imageio-ffmpeg    # render + ffmpeg (sistemde ffmpeg yoksa)
pip install edge-tts                 # seslendirme (VoiceAgent)
```

`ffmpeg` sistemde kuruluysa doğrudan kullanılır; değilse `imageio-ffmpeg`
paketindeki statik sürüm bulunur. Özel bir kurulum için `FFMPEG_PATH`
değişkenini kullanın.

### Tek başına deneme

> `whiteboard-demo` hızlı bir görsel kontroldür: her çalıştırmada 45-50
> saniyelik örnek metinlerden birini **rastgele** seçer. Gerçek akış (trend
> konusu + kendi senaryosu) için `npm run auto-video` kullanın.

```bash
npm run whiteboard-demo
# veya kendi metninizle
node src/scripts/whiteboardDemo.js --text "Bal neden bozulmaz? ..." \
  --audio output/voice.mp3 --srt output/subs.srt
```

Ses dosyası verilmezse video sessiz üretilir; altyazılar yine gömülür.
1080x1920, 30 fps bir videonun kare üretimi ortalama bir dizüstünde
~1-1.5 dakika sürer.

Her çalıştırma kendi zaman damgalı dosyasını üretir, ör.
`output/whiteboard-demo/shorts_whiteboard_20261114-213524.mp4`. Aynı klasörde:

- `preview.jpg` — 4 karelik önizleme (videonun gerçekten yeni olduğunu
  anlamanın en hızlı yolu)
- `run_info.json` — git commit, sahne sırası, kare sayısı, süre, ses dosyası
- `frames/` — kareler (her çalıştırmada sıfırlanır)

Konsol çıktısı ayrıca dosya boyutu ve SHA1 özetini yazar; iki çalıştırmanın
çıktısı aynı görünüyorsa SHA1 ve `run_info.json` içindeki commit ile
karşılaştırabilirsin.

### Windows (PowerShell) notları

`npm : File ...\npm.ps1 cannot be loaded because running scripts is disabled on this system`
hatası PowerShell betik politikasından gelir. Şu seçeneklerden biri:

```powershell
npm.cmd run whiteboard-demo                        # en hızlı çözüm
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned # kalıcı çözüm (yönetici gerekmez)
```

`ERR_MODULE_NOT_FOUND: Cannot find package 'dotenv'` hatası bağımlılıkların
kurulmadığı anlamına gelir:

```powershell
npm install
```

`.env` desteği isteğe bağlıdır: `node_modules` yoksa proje çökmez, yalnızca
`[config] dotenv bulunamadı` uyarısı verir ve doğrudan beyaz tahta demosu
çalışır.

Python birden fazla sürümde kuruluysa (`py`, Microsoft Store sürümü, venv)
`WhiteboardVideoAgent` içinde **Pillow'un kurulu olduğu yorumlayıcı** otomatik
seçilir. Yine de bulunamazsa:

```powershell
py -3 -m pip install Pillow imageio-ffmpeg
$env:PYTHON_BIN = "py"
```

Font otomatik aranır; Windows'ta `C:\Windows\Fonts\arialbd.ttf` kullanılır.
Farklı bir yazı tipi için `WHITEBOARD_FONT` değişkenine `.ttf` yolunu yazın.

### Sahne kütüphanesi

Sahneler `src/whiteboard/scenes.py` içinde vektör çizim darbeleri olarak
tanımlıdır:

- Genel: `egyptian_vase`, `honey_pot`, `milk_bread_honey`, `water_drop`,
  `bacteria_honey`, `bee`, `question`, `clock`, `sun`, `heart`, `house`,
  `book`, `check`, `cross`, `generic`
- Trend/ekonomi: `chart`, `money`, `shopping`, `factory`
- Teknoloji/sağlık/çevre: `phone`, `shield`, `flame`, `cloud_rain`
- Günlük hayat: `coffee`
- Doğa/bilim: `sky`, `rainbow`, `planet`, `coffee`, `tree`, `thermometer`, `ice`, `leaf`, `moon`
- İnsan/algı: `eye`, `ear`, `brain`, `heart`
- Yolculuk: `boat`, `airplane`, `road`, `bridge`, `map`, `ladder`
- Teknoloji/günlük: `lightbulb`, `battery`, `car`, `rocket`, `brain`, `map`

`python src/whiteboard/render.py --list-scenes` komutu güncel listeyi verir.

Katalog 57 nesnedir (buz, tuz, göz, kulak, anahtar, merdiven, köprü, tekne,
uçak, takvim, ay, mıknatıs, yaprak, yol, insan, iki insan, konuşma balonu,
yukarı/aşağı ok, yıldız, büyüteç, dişli dahil). Nesneler tek tek de kullanılır,
1-3 tanesi birleştirilerek sahne kurulur. Bir sahne videoda en fazla 2 kez
kullanılır, arka arkaya aynı sahne gelmez; konu bir sahneyi doyurduğunda
aynı görsel aileden (doğa, günlük hayat, bilim...) anlamca en yakın sahne
seçilir. Hiçbir sahneye uymayan cümlelerde videonun "konu sahnesi" (ör. kahve
anlatımında kahve fincanı) kullanılır; rastgele çizim yapılmaz.

Sahne seçim sırası: Ollama planı → cümlenin `visual` tarifi → anahtar kelimeler →
konu sahnesi → ailesi. Ollama'nın döndürdüğü Türkçe cevaplar ("vazo", "bal
küpü") otomatik olarak katalog kimliğine çevrilir ve kısmi planlar da kabul
edilir. Hangi cümlenin hangi sahneyi hangi kaynakla aldığı `run_info.json`
içindeki `scene_plan` alanında görülür.

Yeni nesne eklemek için `src/whiteboard/scenes.py` içinde `scene_<isim>()`
fonksiyonu yazıp `SCENES` sözlüğüne kaydedin; `SCENE_KEYWORDS` içine anahtar
kelimeleri, `WhiteboardVideoAgent.js` içindeki `SCENE_HINTS` sözlüğüne Türkçe
açıklamayı ekleyin (model bu açıklamadan seçer). İsteğe bağlı olarak `src/agents/WhiteboardVideoAgent.js` içindeki
`SCENE_HINTS` sözlüğüne Türkçe açıklama ekleyin (Ollama'nın seçmesi için).

### El görseli

`src/whiteboard/assets/hand_marker.png` yeşil perdeden alfa kanalına
çevrilmiş bir el sprite'ıdır. Farklı bir el kullanmak için
`hand_marker_raw.png` dosyasını düz yeşil zeminli bir görselle değiştirip:

```bash
python src/whiteboard/prepare_hand.py
```

komutunu çalıştırın. `hand_marker.png` yoksa render vektörel yedek eli kullanır.

Render sırasında elden üç açı/ölçek varyantı üretilir ve kol kadraj dışına
taşacak şekilde uzatılır; her sahne farklı varyantı kullanır. Böylece aynı el
tekrar ediyormuş hissi azalır ve sprite sınırında sert kesik görünmez.

## Hız

45 saniyelik bir videonun tipik süreleri (4 çekirdek CPU, GPU yok):

| Adım | Süre |
| --- | --- |
| Konu seçimi (Ollama) | 20-45 sn |
| Senaryo (Ollama, 3-4 istek) | 90-180 sn |
| Seslendirme (edge-tts) | 5-10 sn |
| Kare çizimi + kodlama | 60-120 sn |

Hız için:

- `OLLAMA_NUM_GPU` **boş** bırakılmalı; `0` yazmak modeli CPU'ya kilitler.
- `OLLAMA_KEEP_ALIVE=1h` modelin bellekte kalmasını sağlar (ilk yükleme 10-30 sn).
- Ek Ollama incelemesi varsayılan olarak **kapalı**; `--review` ile açılır (her tur ~1 dk ekler).
- Kareler varsayılan olarak **JPEG** yazılır (`FRAME_FORMAT=jpg`). PNG yaklaşık 4 kat yavaştır.
- `--topic "..."` ile konu seçimini, `--text "..."` ile senaryo üretimini atlayabilirsiniz.

## Ses sorunları

Video üretildikten sonra konsolda iki satırdan birini görürsünüz:

- `Ses videoya eklendi (46.2s).` → ses mp4 içinde.
- `UYARI: Ses dosyası verildi ama mp4 içinde ses akışı yok!` → mux başarısız.

Seslendirme hiç üretilemezse akış açık hata verir (`Seslendirme başarısız...`),
sessiz video üretmez. Sık nedenler: `edge_tts` yanlış Python'a kurulu
(`PYTHON_BIN` ayarlayın), internet yok veya `TTS_VOICE` geçersiz.

### Altyazı / zamanlama sorunları

- `Ses: 78 KB, 412 kelime zamanı, 61 altyazı parçası.` → zamanlama TTS'ten
  alındı, altyazılar 6-8 kelimelik parçalar hâlinde cümle sınırlarına oturuyor.
- `Kelime zamanlaması alınamadı (...); CLI yedeğine geçiliyor.` → `edge_tts`
  sürümü kelime sınırı bilgisi vermiyor. Çözüm: `python -m pip install -U edge-tts`.
  Bu durumda video üretilir ama altyazı zamanlaması edge-tts'in kendi VTT'sinden
  gelir (daha kaba).
- `Zamanlama kaynağı: kelime zamanları | altyazı ipuçları | tahmini` satırı
  hangi yolun kullanıldığını söyler.

### Araştırma (konu doğrulama)

`ResearchAgent` konu hakkında Türkçe Wikipedia özetini çeker ve senaryo
planına "doğrulanmış bilgi" olarak verir; böylece cümleler uydurma yerine
gerçek bilgiye dayanır. Ağ yoksa veya madde bulunamazsa uyarı yazıp normal
üretime devam eder (`Araştırma yapılamadı ...`).

## Kontroller

Projede ayrı bir test paketi yok; hızlı doğrulama için:

```bash
node --check src/agents/WhiteboardVideoAgent.js   # sözdizimi
node --check src/scripts/autoVideo.js
npm run whiteboard-demo                           # uçtan uca duman testi (sessiz video)
```

`npm run whiteboard-demo` ~45 saniyelik sessiz bir video üretir; süre, sahne
zinciri ve çıktı dosyası konsolda raporlanır. `run_info.json` içindeki
`duration` değeri beklenen aralıkta mı diye bakın.

## Yapılandırma

İsteğe bağlı olarak `.env.example` dosyasındaki değişkenleri ortam değişkeni olarak tanımlayın:

- `OLLAMA_BASE_URL`: Ollama Chat API adresi
- `OLLAMA_MODEL`: Kullanılacak model

Proje `.env` dosyasını otomatik yükler. Senaryo, senaryo inceleme, trend seçimi ve hata analizi yerel Ollama modeliyle çalışır; bu akışlarda Gemini API anahtarı kullanılmaz.

## Mevcut doğrulama sınırı

Manager; Developer çıktısında tam olarak bir TypeScript kod bloğu arar, bu kodu geçici bir dosyada TypeScript derleyicisiyle kontrol eder ve Reviewer değerlendirmesini bekler. Üretilen kodu otomatik çalıştırmaz. Derleme kontrolü, kodun çalışma zamanı davranışının doğru olduğunu tek başına kanıtlamaz.

## Güvenlik notu

Model çıktısı güvenilir kod kabul edilmemelidir. Bu sürüm üretilen kodu otomatik çalıştırmaz. İleride çalışma zamanı testi eklenecekse ayrı ve kısıtlı bir sandbox kullanılmalıdır.
