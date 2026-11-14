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
npm start
```

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
3. `src/whiteboard/render.py` (Pillow) her sahneyi kare kare çizer: çizgi
   darbeleri sahne süresinin ilk %80'inde tamamlanır, el kalemi takip eder ve
   sahne sonunda kareyi terk eder. Altyazılar da karelere gömülür.
4. `ffmpeg` kareleri ses ile birleştirip `shorts_whiteboard.mp4` üretir.

### Gereksinimler

```bash
pip install Pillow imageio-ffmpeg    # render + ffmpeg (sistemde ffmpeg yoksa)
pip install edge-tts                 # seslendirme (VoiceAgent)
```

`ffmpeg` sistemde kuruluysa doğrudan kullanılır; değilse `imageio-ffmpeg`
paketindeki statik sürüm bulunur. Özel bir kurulum için `FFMPEG_PATH`
değişkenini kullanın.

### Tek başına deneme

```bash
npm run whiteboard-demo
# veya kendi metninizle
node src/scripts/whiteboardDemo.js --text "Bal neden bozulmaz? ..." \
  --audio output/voice.mp3 --srt output/subs.srt
```

Ses dosyası verilmezse video sessiz üretilir; altyazılar yine gömülür.
Çıktı: `output/whiteboard-demo/shorts_whiteboard.mp4`.

### Sahne kütüphanesi

Sahneler `src/whiteboard/scenes.py` içinde vektör çizim darbeleri olarak
tanımlıdır: `egyptian_vase`, `honey_pot`, `milk_bread_honey`, `water_drop`,
`bacteria_honey`, `question`, `clock`, `sun`, `heart`, `money`, `house`,
`book`, `check`, `cross`, `generic`.

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

## Kontroller

```bash
npm run typecheck
npm test
```

`npm test` şu an TypeScript tür kontrolünü çalıştırır; henüz ayrı bir birim test paketi değildir.

## Yapılandırma

İsteğe bağlı olarak `.env.example` dosyasındaki değişkenleri ortam değişkeni olarak tanımlayın:

- `OLLAMA_BASE_URL`: Ollama Chat API adresi
- `OLLAMA_MODEL`: Kullanılacak model

Proje `.env` dosyasını otomatik yükler. Senaryo, senaryo inceleme, trend seçimi ve hata analizi yerel Ollama modeliyle çalışır; bu akışlarda Gemini API anahtarı kullanılmaz.

## Mevcut doğrulama sınırı

Manager; Developer çıktısında tam olarak bir TypeScript kod bloğu arar, bu kodu geçici bir dosyada TypeScript derleyicisiyle kontrol eder ve Reviewer değerlendirmesini bekler. Üretilen kodu otomatik çalıştırmaz. Derleme kontrolü, kodun çalışma zamanı davranışının doğru olduğunu tek başına kanıtlamaz.

## Güvenlik notu

Model çıktısı güvenilir kod kabul edilmemelidir. Bu sürüm üretilen kodu otomatik çalıştırmaz. İleride çalışma zamanı testi eklenecekse ayrı ve kısıtlı bir sandbox kullanılmalıdır.
