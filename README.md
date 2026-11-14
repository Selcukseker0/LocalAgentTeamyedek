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

## Shorts video görünümü

Video montajında stok kliplere yavaş yakınlaşma/uzaklaşma hareketi ve sahneler arasında kısa geçişler uygulanır. Altyazılar büyük, kenarlıklı ve kısa bir açılma animasyonuyla gösterilir. Bu efektler için FFmpeg kurulumunda `zoompan`, `xfade` ve `ass` filtreleri (libass) bulunmalıdır.

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
