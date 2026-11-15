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
ollama pull qwen2.5:7b
```

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
3. `ScriptAgent` senaryoyu **parça parça** üretir (küçük modeller 130 kelimeyi
   tek yanıtta yazamıyor):
   1. plan çağrısı → başlık, kanca, üç sebep, kapanış sorusu,
   2. bölüm 1 → kanca + soru + birinci sebep (7 cümle),
   3. bölüm 2 → ikinci/üçüncü sebep (6 cümle),
   4. gerekirse ek cümle çağrısı (hedefe ulaşmak için).

   Toplam 127-149 kelime (45-50 sn). 109 kelimenin altında kalırsa açık hata
   verilir; üstündeyse uyarı ile devam edilir. `--review` ile ek inceleme
   yapılabilir.
4. Ses `edge-tts` ile üretilir, video gerçek ses süresine göre karelenir;
   yani süre tahmini değil, ölçülen ses süresi esastır.

Senaryo, modele "cümle dizisi" olarak yazdırılır:

```json
{"sentences":[{"text":"cümlenin kendisi","visual":"tahtaya çizilecek sahne","title":"vurgu"}]}
```

12-16 cümle, her cümle 9-11 kelime. Model kısa yazarsa senaryo iki tura kadar
genişletilir; 109 kelimenin altında kalırsa açık hata verilir (bozuk video
üretilmez). Uzun çıktı ise kısaltılır.

Cümleler altyazıya girmeden önce denetlenir:

- Prompt şablonu artıkları (`Kanca cümlesi:`, `Soru cümlesi:`, `Sebep 2:`)
  cümleden **silinir**; model bunları metin sanıp yazsa bile altyazıya düşmez.
- 6 kelimeden kısa, üç nokta ile yarım kalmış veya bağlaçla biten cümleler
  atılır (`…` ile biten cümle altyazı olmaz).
- Tekrar eden cümleler birebir değil, kelime örtüşmesine göre (%72) ayıklanır.

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

## Shorts video görünümü (beyaz tahta / keçeli kalem stili)

Videolar stok klip yerine **beyaz kâğıt üzerine keçeli kalemle çizim** olarak
üretilir: dikey 1080x1920, beyaz zemin, siyah marker çizgileri, seçici renk
dolguları (bal sarısı, süt mavisi, ekmek kahvesi) ve sağ alttan giren gerçek
bir el. Altyazılar ekranın altında koyu yarı saydam kutuda beyaz kalın yazıyla
gösterilir.

Akış:

1. `WhiteboardVideoAgent` senaryoyu cümlelere böler ve süreleri ses dosyası /
   SRT zamanlamasından çıkarır.
2. Her cümle için bir sahne seçilir: Ollama varsa model seçer, yoksa Türkçe
   anahtar kelime eşlemesi devreye girer (`src/agents/WhiteboardVideoAgent.js`).
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

Katalog 49 sahnedir (buz, tuz, göz, kulak, anahtar, merdiven, köprü, tekne,
uçak, takvim, ay, mıknatıs, yaprak, yol dahil). Bir sahne videoda en fazla 2 kez
kullanılır, arka arkaya aynı sahne gelmez; konu bir sahneyi doyurduğunda
aynı görsel aileden (doğa, günlük hayat, bilim...) anlamca en yakın sahne
seçilir. Hiçbir sahneye uymayan cümlelerde videonun "konu sahnesi" (ör. kahve
anlatımında kahve fincanı) kullanılır; rastgele çizim yapılmaz.

Sahne seçim sırası: Ollama planı → cümlenin `visual` tarifi → anahtar kelimeler →
konu sahnesi → ailesi. Ollama'nın döndürdüğü Türkçe cevaplar ("vazo", "bal
küpü") otomatik olarak katalog kimliğine çevrilir ve kısmi planlar da kabul
edilir. Hangi cümlenin hangi sahneyi hangi kaynakla aldığı `run_info.json`
içindeki `scene_plan` alanında görülür.

Yeni sahne eklemek için aynı dosyada `scene_<isim>()` fonksiyonu yazıp
`SCENES` sözlüğüne kaydedin; `SCENE_KEYWORDS` içine anahtar kelimeleri
ekleyin. İsteğe bağlı olarak `src/agents/WhiteboardVideoAgent.js` içindeki
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
