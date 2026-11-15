"""Beyaz tahta (whiteboard) sahne çizim kütüphanesi.

Her sahne, sırayla çizilecek "stroke" (kalem darbesi) listesi döndürür.
Stroke = (noktalar, renk, kalınlık) demeti. Noktalar [(x, y), ...] listesidir.

Koordinatlar 1080x1920 dikey tuval içindir. Çizim alanı kabaca
x: 90-990, y: 250-1450 aralığındadır; alt kısım altyazıya ayrılmıştır.

Bu dosya bilerek basit geometri kullanır: elips, dikdörtgen, çokgen ve
örneklenmiş eğriler. Amaç, referans videodaki gibi "siyah keçeli kalemle
beyaz kâğıda hızlı çizim" hissini Pillow ile yakalamaktır.
"""

import math
import random

W, H = 1080, 1920

BLACK = (20, 20, 20)
HONEY = (232, 176, 32)
HONEY_DARK = (196, 138, 16)
MILK_BLUE = (66, 133, 199)
BREAD = (196, 138, 74)
BREAD_DARK = (120, 72, 32)
GRAY = (120, 120, 120)
GREEN = (76, 156, 96)
RED = (198, 74, 62)
ORANGE = (232, 142, 46)
SKY = (118, 176, 220)

# Sahne kimliği -> Türkçe anahtar kelimeler (ScriptAgent sahne veremezse yedek eşleme)
SCENE_KEYWORDS = {
    "egyptian_vase": ["mısır", "misir", "mezar", "vazo", "antik", "firavun", "tarih", "arkeolog"],
    "honey_pot": ["bal", "tatlı", "tatli", "şeker", "seker", "reçel", "rec el"],
    "coffee": ["kahve", "çekirdek", "cekirdek", "fincan", "bardak", "kafein", "barista", "koku"],
    "lightbulb": ["ampul", "fikir", "icat", "elektrik", "buluş", "bulus", "lamba", "ışık ver"],
    "battery": ["pil", "batarya", "şarj", "sarj", "enerji depolar", "tüken", "tuken"],
    "tree": ["ağaç", "agac", "orman", "oksijen", "yaprak", "doğa", "doga", "kök", "kok sal"],
    "car": ["araba", "otomobil", "trafik", "yol", "sürücü", "surucu", "park", "lastik"],
    "rocket": ["roket", "uzaya", "fırlat", "firlat", "hız", "hiz rekor", "keşif", "kesif"],
    "brain": ["beyin", "düşünce", "dusunce", "hafıza", "hafiza", "öğren", "ogren", "zeka", "unut"],
    "map": ["harita", "konum", "rota", "seyahat", "ülke", "ulke", "şehir", "sehir", "kıta", "kita"],
    "thermometer": ["termometre", "sıcaklık", "sicaklik", "derece", "ateş", "ates", "ısı", "isi", "soğuk", "soguk", "iklim"],
    "milk_bread_honey": ["süt", "sut", "ekmek", "bozul", "bozuk", "gıda", "gida"],
    "water_drop": ["su", "damla", "nem", "ıslak", "islak", "kuruma"],
    "bacteria_honey": ["bakteri", "mikrop", "kurut", "öldür", "oldur", "hastalık", "hastalik"],
    "question": ["neden", "nasıl", "nasil", "soru", "?", "merak"],
    "clock": ["saat", "zaman", "yıl", "yil", "süre", "sure", "dakika"],
    "sun": ["güneş", "gunes", "sıcak", "sicak", "yaz", "ışın", "isin", "parlak"],
    "sky": ["gökyüzü", "gokyuzu", "ufuk", "gündüz", "gunduz", "mavi", "hava"],
    "rainbow": ["gökkuşağı", "gokkusagi", "renk", "spektrum", "ışık", "isik", "tayf"],
    "planet": ["gezegen", "dünya", "dunya", "uzay", "mars", "ay ", "yıldız", "yildiz", "astronot"],
    "heart": ["kalp", "sevgi", "aşk", "ask", "mutlu"],
    "money": ["para", "dolar", "euro", "zengin", "fiyat", "ekonomi"],
    "house": ["ev", "yuva", "oda", "kapı", "kapi"],
    "book": ["kitap", "okul", "ders", "öğren", "ogren", "bilgi"],
    "check": ["doğru", "dogru", "evet", "onay", "başarı", "basari"],
    "cross": ["yanlış", "yanlis", "hayır", "hata", "dur"],
    "bee": ["arı", "ari", "bal", "petek", "doğa", "doga", "çiçek", "cicek"],
    "phone": ["telefon", "uygulama", "sosyal medya", "internet", "ekran", "yapay zeka"],
    "chart": ["grafik", "artış", "artis", "istatistik", "büyüme", "buyume", "oran", "ekonomi"],
    "shield": ["koruma", "güvenlik", "guvenlik", "sağlık", "saglik", "bağışıklık", "bagisiklik"],
    "flame": ["ateş", "ates", "sıcak", "sicak", "enerji", "yangın", "yangin", "ısı", "isi"],
    "factory": ["fabrika", "üretim", "uretim", "sanayi", "kirlilik", "ihracat"],
    "cloud_rain": ["yağmur", "yagmur", "hava", "iklim", "bulut", "kuraklık", "kuraklik"],
    "ice": ["buz", "don", "donma", "soğuk", "soguk", "kutup", "erime", "eriyor", "kar"],
    "salt": ["tuz", "tuzlu", "deniz suyu", "tat", "kristal"],
    "eye": ["göz", "goz", "bak", "gör", "gor", "görme", "gorme", "dikkat", "izle"],
    "ear": ["kulak", "ses", "duy", "gürültü", "gurultu", "müzik", "muzik", "dinle"],
    "key": ["anahtar", "kilit", "aç", "ac", "şifre", "sifre", "erişim", "erisim"],
    "ladder": ["merdiven", "yüksel", "yuksel", "tırman", "tirman", "adım", "adim", "hedef"],
    "bridge": ["köprü", "kopru", "bağla", "bagla", "geçiş", "gecis", "iki yaka"],
    "boat": ["gemi", "tekne", "yelken", "deniz", "okyanus", "liman", "yolculuk", "ticaret"],
    "airplane": ["uçak", "ucak", "uçuş", "ucus", "havayolu", "pilot", "seyahat", "havaalanı", "havaalani"],
    "calendar": ["takvim", "gün", "gun", "tarih", "ayın", "ayin", "hafta", "plan"],
    "moon": ["ay", "gece", "uyku", "döngü", "dongu", "gelgit", "dolunay"],
    "magnet": ["mıknatıs", "miknatis", "manyetik", "çekim", "cekim", "pusula"],
    "leaf": ["yaprak", "bitki", "çiçek", "cicek", "mevsim", "fotosentez", "yeşil", "yesil"],
    "road": ["yol", "patika", "yolculuk", "hedef", "süreç", "surec", "rota"],
    "person": ["insan", "kişi", "kisi", "biri", "kullanıcı", "kullanici", "çocuk", "cocuk"],
    "two_people": ["iki kişi", "iki kisi", "insanlar", "topluluk", "herkes", "konuşuyor", "konusuyor"],
    "arrow_up": ["artıyor", "artiyor", "yüksel", "yuksel", "çoğal", "cogal", "iyileş", "iyiles"],
    "arrow_down": ["azalıyor", "azaliyor", "düşüyor", "dusuyor", "eriyor", "tükeniyor", "tukeniyor"],
    "bubble": ["söylüyor", "soyluyor", "anlatıyor", "anlatiyor", "konuşma", "konusma", "söylenti"],
    "star": ["başarı", "basari", "hedef", "yıldız", "yildiz", "parlak", "ödül", "odul"],
    "magnifier": ["araştır", "arastir", "incele", "kanıt", "kanit", "detay", "gözlem", "gozlem"],
    "gear": ["sistem", "mekanizma", "makine", "ayar", "düzenek", "duzenek", "işleyiş", "isleyis"],
    "shopping": ["alışveriş", "alisveris", "fiyat", "indirim", "tüketim", "tuketim", "market"],
}


def _jitter(points, amount=2.0, seed=0):
    rnd = random.Random(seed)
    return [(x + rnd.uniform(-amount, amount), y + rnd.uniform(-amount, amount)) for x, y in points]


def _line(p1, p2, n=24):
    return [(p1[0] + (p2[0] - p1[0]) * i / n, p1[1] + (p2[1] - p1[1]) * i / n) for i in range(n + 1)]


def _ellipse(cx, cy, rx, ry, n=48, start=0.0, end=2 * math.pi):
    return [(cx + rx * math.cos(start + (end - start) * i / n),
             cy + ry * math.sin(start + (end - start) * i / n)) for i in range(n + 1)]


def _rect(x1, y1, x2, y2):
    return [(x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, y1)]


def _bezier(p0, p1, p2, p3, n=32):
    pts = []
    for i in range(n + 1):
        t = i / n
        x = (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * p1[0] + 3 * (1 - t) * t ** 2 * p2[0] + t ** 3 * p3[0]
        y = (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * p1[1] + 3 * (1 - t) * t ** 2 * p2[1] + t ** 3 * p3[1]
        pts.append((x, y))
    return pts


def _poly(points):
    return list(points) + [points[0]]


def _drop(cx, cy, w, h):
    """Su damlası: üstte sivri, altta yuvarlak."""
    top = (cx, cy - h / 2)
    left = (cx - w / 2, cy + h * 0.05)
    right = (cx + w / 2, cy + h * 0.05)
    bottom = (cx, cy + h / 2)
    pts = []
    pts += _bezier(top, (cx - w * 0.42, cy - h * 0.18), (cx - w * 0.52, cy + h * 0.05), left, 16)
    pts += _bezier(left, (cx - w * 0.48, cy + h * 0.32), (cx - w * 0.28, bottom[1]), bottom, 16)
    pts += _bezier(bottom, (cx + w * 0.28, bottom[1]), (cx + w * 0.48, cy + h * 0.32), right, 16)
    pts += _bezier(right, (cx + w * 0.52, cy + h * 0.05), (cx + w * 0.42, cy - h * 0.18), top, 16)
    return pts


def _fill_poly(points, color, width=0):
    """Renk doldurma için kapalı çokgeni stroke olarak döndür (ince çizgiyle)."""
    return (_poly(points), color, width)


# ---------------------------------------------------------------- sahneler

def scene_egyptian_vase():
    """Hiyeroglifli Mısır vazosu (referans kare 1)."""
    s = []
    cx, top, bot = 540, 480, 1180
    # Gövde: iki yan eğri + ağız + kaide
    left = _bezier((cx - 95, top + 60), (cx - 230, top + 260), (cx - 240, bot - 320), (cx - 150, bot - 40), 24)
    right = _bezier((cx + 95, top + 60), (cx + 230, top + 260), (cx + 240, bot - 320), (cx + 150, bot - 40), 24)
    s.append((left, BLACK, 12))
    s.append((right, BLACK, 12))
    s.append((_ellipse(cx, top + 60, 105, 34), BLACK, 12))          # ağız
    s.append((_ellipse(cx, top + 60, 78, 22), BLACK, 8))             # ağız içi
    s.append((_line((cx - 95, top + 60), (cx - 95, top + 130)), BLACK, 12))
    s.append((_line((cx + 95, top + 60), (cx + 95, top + 130)), BLACK, 12))
    s.append((_line((cx - 150, bot - 40), (cx + 150, bot - 40)), BLACK, 12))
    s.append((_line((cx - 150, bot - 40), (cx - 150, bot - 90)), BLACK, 12))
    s.append((_line((cx + 150, bot - 40), (cx + 150, bot - 90)), BLACK, 12))
    # Boyun çizgileri
    for i, y in enumerate([top + 170, top + 210, top + 250]):
        s.append((_line((cx - 150 + i * 8, y), (cx + 150 - i * 8, y)), BLACK, 8))
    # Hiyeroglif bantları: 3 sıra küçük semboller
    for row, y in enumerate([top + 330, top + 450, top + 570]):
        s.append((_line((cx - 195, y - 45), (cx + 195, y - 45)), BLACK, 8))
        s.append((_line((cx - 195, y + 45), (cx + 195, y + 45)), BLACK, 8))
        for k in range(5):
            x = cx - 150 + k * 75
            kind = (row + k) % 4
            if kind == 0:      # dikdörtgen
                s.append((_rect(x - 22, y - 28, x + 22, y + 28), BLACK, 7))
            elif kind == 1:    # üçgen
                s.append((_poly([(x, y - 30), (x - 24, y + 26), (x + 24, y + 26)]), BLACK, 7))
            elif kind == 2:    # dalgalı çizgi
                s.append(([(x - 24 + i * 4, y + (8 if i % 2 == 0 else -8)) for i in range(13)], BLACK, 7))
            else:              # daire
                s.append((_ellipse(x, y, 20, 20), BLACK, 7))
    # Kaide çizgileri
    for y in [bot - 140, bot - 110]:
        s.append((_line((cx - 165, y), (cx + 165, y)), BLACK, 8))
    return s


def scene_honey_pot():
    """Bal küpü, ağzından taşan bal ve süzülen damla (referans kare 2)."""
    s = []
    # Küp gövdesi
    body = _bezier((330, 700), (300, 950), (330, 1150), (430, 1220), 20)
    body += _bezier((430, 1220), (560, 1260), (700, 1260), (800, 1220), 20)
    body += _bezier((800, 1220), (830, 1150), (800, 950), (770, 700), 20)
    s.append((body, BLACK, 12))
    s.append((_ellipse(550, 700, 220, 52), BLACK, 12))               # ağız
    s.append((_ellipse(550, 700, 172, 34), BLACK, 8))                # iç ağız

    # Bal yüzeyi (ağız içi)
    s.append((_ellipse(550, 706, 166, 30), HONEY, 0))

    # Ağızdan taşıp küpün ön yüzünden süzülen bal
    drip = _bezier((652, 706), (636, 800), (640, 900), (628, 946), 16)
    drip += _bezier((628, 946), (650, 1000), (738, 1000), (760, 946), 16)
    drip += _bezier((760, 946), (748, 900), (752, 800), (736, 706), 16)
    s.append((_poly(drip), HONEY, 0))
    s.append((_poly(drip), BLACK, 9))
    # Bal yüzeyindeki parlaklık
    s.append((_bezier((668, 760), (660, 830), (664, 880), (666, 906), 12), (255, 244, 214), 6))

    # Kopan damla
    s.append((_drop(700, 1200, 78, 136), HONEY, 0))
    s.append((_drop(700, 1200, 78, 136), BLACK, 9))

    # Küp üzerindeki çizgiler (dokuma hissi)
    s.append((_line((352, 1040), (748, 1040)), BLACK, 8))
    s.append((_line((362, 1104), (738, 1104)), BLACK, 8))
    return s


def scene_milk_bread_honey():
    """Süt kutusu + ekmek + bal kavanozu + soru işareti (referans kare 3)."""
    s = []
    # Süt kutusu (sol)
    s.append((_rect(120, 620, 380, 1180), BLACK, 12))
    s.append((_poly([(120, 620), (250, 500), (380, 620)]), BLACK, 12))
    s.append((_line((250, 500), (250, 620)), BLACK, 10))
    s.append((_rect(160, 820, 340, 1080), MILK_BLUE, 0))
    s.append((_rect(160, 820, 340, 1080), BLACK, 10))
    # Ekmek (alt sol)
    bread = _bezier((110, 1330), (110, 1200), (300, 1170), (430, 1240), 16)
    bread += _bezier((430, 1240), (560, 1310), (560, 1420), (430, 1460), 16)
    bread += _bezier((430, 1460), (250, 1500), (110, 1440), (110, 1330), 16)
    s.append((_poly(bread), BREAD, 0))
    s.append((_poly(bread), BLACK, 12))
    for x in [220, 320, 420]:
        s.append((_line((x, 1280), (x + 40, 1340)), BREAD_DARK, 8))
    # Bal kavanozu (sağ)
    s.append((_rect(680, 780, 980, 1330), BLACK, 12))
    s.append((_rect(660, 700, 1000, 790), BLACK, 12))
    s.append((_rect(700, 860, 960, 1250), HONEY, 0))
    s.append((_rect(700, 860, 960, 1250), BLACK, 10))
    # Petek (üst sağ)
    s.append((_ellipse(900, 560, 110, 80), BLACK, 10))
    s.append((_ellipse(900, 560, 70, 48), HONEY, 0))
    # Soru işareti (orta, kavanozdan sola kayık)
    q = _bezier((500, 700), (570, 640), (620, 750), (550, 840), 20)
    q += _bezier((550, 840), (495, 910), (495, 970), (495, 1010), 16)
    s.append((q, BLACK, 16))
    s.append((_ellipse(495, 1110, 26, 26), BLACK, 16))
    return s


def scene_water_drop():
    """Boş su damlası + üstü çizili bal damlası (referans kare 4)."""
    s = []
    s.append((_drop(420, 880, 420, 720), BLACK, 14))
    s.append((_ellipse(420, 1230, 150, 46), BLACK, 10))              # damla içi taban
    s.append((_bezier((300, 800), (330, 700), (380, 640), (420, 600), 12), GRAY, 8))
    # Küçük bal damlası + çarpı
    small = _drop(850, 760, 200, 300)
    s.append((_poly(small), HONEY, 0))
    s.append((_poly(small), BLACK, 12))
    s.append((_line((760, 640), (940, 880)), BLACK, 16))
    return s


def scene_bacteria_honey():
    """Bal havuzu içinde bakteriler (referans kare 5)."""
    s = []
    # Bal havuzu (dalgalı blob)
    blob = _bezier((200, 900), (180, 700), (420, 620), (600, 700), 20)
    blob += _bezier((600, 700), (820, 620), (950, 780), (880, 950), 20)
    blob += _bezier((880, 950), (820, 1150), (600, 1220), (420, 1150), 20)
    blob += _bezier((420, 1150), (220, 1120), (180, 1020), (200, 900), 20)
    s.append((_poly(blob), HONEY, 0))
    s.append((_poly(blob), BLACK, 12))
    # Bakteriler: dikenli ovaler
    for (cx, cy, r) in [(420, 860, 46), (600, 800, 40), (740, 900, 44),
                        (500, 1020, 42), (680, 1060, 40), (330, 1000, 36)]:
        s.append((_ellipse(cx, cy, r, r * 0.72), BLACK, 9))
        for a in range(0, 360, 45):
            rad = math.radians(a)
            x1, y1 = cx + r * 0.72 * math.cos(rad), cy + r * 0.72 * math.sin(rad)
            x2, y2 = cx + (r + 22) * 0.72 * math.cos(rad), cy + (r + 22) * 0.72 * math.sin(rad)
            s.append((_line((x1, y1), (x2, y2)), BLACK, 7))
        s.append((_ellipse(cx, cy, 8, 8), BLACK, 6))
    return s


def scene_question():
    s = []
    q = _bezier((470, 620), (620, 540), (740, 680), (640, 800), 24)
    q += _bezier((640, 800), (540, 920), (540, 1000), (540, 1060), 18)
    s.append((q, BLACK, 22))
    s.append((_ellipse(540, 1180, 36, 36), BLACK, 22))
    return s


def scene_clock():
    s = [(_ellipse(540, 900, 260, 260), BLACK, 14)]
    s.append((_line((540, 900), (540, 720)), BLACK, 14))
    s.append((_line((540, 900), (680, 980)), BLACK, 14))
    for a in range(0, 360, 30):
        rad = math.radians(a)
        s.append((_line((540 + 210 * math.cos(rad), 900 + 210 * math.sin(rad)),
                        (540 + 240 * math.cos(rad), 900 + 240 * math.sin(rad))), BLACK, 8))
    return s


def scene_sun():
    s = [(_ellipse(540, 900, 170, 170), HONEY, 0),
         (_ellipse(540, 900, 170, 170), BLACK, 14)]
    for a in range(0, 360, 30):
        rad = math.radians(a)
        s.append((_line((540 + 210 * math.cos(rad), 900 + 210 * math.sin(rad)),
                        (540 + 300 * math.cos(rad), 900 + 300 * math.sin(rad))), BLACK, 12))
    return s


def scene_heart():
    s = []
    left = _bezier((540, 1150), (300, 950), (280, 700), (430, 620), 20)
    left += _bezier((430, 620), (500, 580), (540, 640), (540, 700), 16)
    right = _bezier((540, 700), (540, 640), (580, 580), (650, 620), 16)
    right += _bezier((650, 620), (800, 700), (780, 950), (540, 1150), 20)
    s.append((left + right, BLACK, 14))
    return s


def scene_money():
    s = [(_rect(300, 700, 780, 1100), BLACK, 14),
         (_rect(340, 740, 740, 1060), BLACK, 8),
         (_ellipse(540, 900, 110, 110), BLACK, 12),
         (_line((540, 820), (540, 980)), BLACK, 10)]
    return s


def scene_house():
    s = [(_rect(320, 850, 760, 1250), BLACK, 14),
         (_poly([(280, 850), (540, 600), (800, 850)]), BLACK, 14),
         (_rect(480, 1020, 600, 1250), BLACK, 12),
         (_rect(380, 920, 470, 1010), BLACK, 10),
         (_rect(610, 920, 700, 1010), BLACK, 10)]
    return s


def scene_book():
    s = [(_rect(300, 650, 780, 1150), BLACK, 14),
         (_line((540, 650), (540, 1150)), BLACK, 10)]
    for y in [760, 860, 960]:
        s.append((_line((360, y), (480, y)), BLACK, 8))
        s.append((_line((600, y), (720, y)), BLACK, 8))
    return s


def scene_check():
    return [(_poly([(320, 900), (480, 1080), (780, 700)]), BLACK, 24)]


def scene_cross():
    return [(_line((380, 700), (700, 1020)), BLACK, 24),
            (_line((700, 700), (380, 1020)), BLACK, 24)]


def scene_generic():
    """Bilinmeyen konu için nötr sahne: soru işareti + yıldız."""
    s = scene_question()
    cx, cy = 540, 1350
    star = []
    for i in range(10):
        r = 90 if i % 2 == 0 else 40
        a = math.radians(-90 + i * 36)
        star.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    s.append((_poly(star), BLACK, 10))
    return s



def scene_bee():
    """Petek + arı (bal, doğa, arıcılık)."""
    s = []
    # Petek
    cx, cy, r = 430, 620, 90
    hexes = [(0, 0), (1, 0), (0.5, 0.85), (-0.5, 0.85), (1.5, 0.85), (0.5, -0.85), (-0.5, -0.85)]
    for hx, hy in hexes:
        px, py = cx + hx * r * 1.5, cy + hy * r * 1.6
        pts = [(px + r * math.cos(math.radians(60 * i + 30)),
                py + r * math.sin(math.radians(60 * i + 30))) for i in range(6)]
        s.append((_poly(pts), BLACK, 8))
        s.append((_poly(pts), HONEY, 0))
    # Arı gövdesi
    s.append((_ellipse(760, 980, 150, 100), HONEY, 0))
    s.append((_ellipse(760, 980, 150, 100), BLACK, 12))
    for x in (700, 748, 796):
        s.append((_bezier((x, 890), (x + 12, 940), (x + 12, 1020), (x, 1070), 10), BLACK, 12))
    s.append((_ellipse(620, 960, 55, 55), BLACK, 10))          # baş
    s.append((_line((600, 910), (560, 860)), BLACK, 9))        # anten
    s.append((_line((640, 906), (660, 850)), BLACK, 9))
    # Kanatlar
    s.append((_ellipse(750, 870, 95, 45), SKY, 0))
    s.append((_ellipse(750, 870, 95, 45), BLACK, 9))
    s.append((_ellipse(850, 890, 80, 38), SKY, 0))
    s.append((_ellipse(850, 890, 80, 38), BLACK, 9))
    # Uçuş izi
    s.append((_bezier((150, 1100), (300, 1000), (420, 1120), (560, 1010), 24), GRAY, 7))
    return s


def scene_phone():
    """Telefon / uygulama (teknoloji, sosyal medya)."""
    s = []
    s.append((_rect(370, 420, 710, 1240), BLACK, 14))
    s.append((_rect(400, 470, 680, 1180), BLACK, 9))
    s.append((_line((500, 445), (580, 445)), BLACK, 9))
    # Sohbet balonları
    s.append((_rect(430, 540, 640, 660), SKY, 0))
    s.append((_rect(430, 540, 640, 660), BLACK, 9))
    s.append((_rect(470, 720, 650, 840), GRAY, 0))
    s.append((_rect(470, 720, 650, 840), BLACK, 9))
    s.append((_rect(430, 900, 610, 1020), GREEN, 0))
    s.append((_rect(430, 900, 610, 1020), BLACK, 9))
    # Ana ekran tuşu
    s.append((_line((500, 1140), (580, 1140)), BLACK, 10))
    return s


def scene_chart():
    """Yükselen grafik (ekonomi, büyüme, istatistik)."""
    s = []
    s.append((_line((200, 1250), (880, 1250)), BLACK, 12))       # x ekseni
    s.append((_line((200, 1250), (200, 560)), BLACK, 12))        # y ekseni
    for i, (x, h) in enumerate([(280, 220), (400, 380), (520, 300), (640, 520), (760, 680)]):
        top = 1250 - h
        s.append((_rect(x, top, x + 80, 1250), GREEN if i % 2 == 0 else HONEY, 0))
        s.append((_rect(x, top, x + 80, 1250), BLACK, 9))
    # Trend oku
    s.append((_bezier((250, 900), (420, 860), (600, 720), (800, 600), 22), BLACK, 10))
    s.append((_poly([(800, 600), (760, 590), (786, 640)]), BLACK, 0))
    return s


def scene_shield():
    """Kalkan (koruma, güvenlik, sağlık)."""
    s = []
    outline = _line((390, 570), (690, 570), 14)
    outline += _bezier((690, 570), (752, 800), (664, 1100), (540, 1245), 22)
    outline += _bezier((540, 1245), (416, 1100), (328, 800), (390, 570), 22)
    outline.append((390, 570))
    s.append((outline, SKY, 0))
    s.append((outline, BLACK, 13))
    s.append((_line((432, 900), (508, 986), 14), BLACK, 17))
    s.append((_line((508, 986), (676, 778), 18), BLACK, 17))
    return s


def scene_flame():
    """Alev (enerji, sıcaklık, yangın)."""
    s = []
    outer = _bezier((540, 520), (700, 640), (760, 860), (700, 1080), 20)
    outer += _bezier((700, 1080), (660, 1240), (600, 1300), (540, 1300), 16)
    outer += _bezier((540, 1300), (470, 1300), (420, 1240), (400, 1080), 16)
    outer += _bezier((400, 1080), (380, 900), (450, 700), (540, 520), 20)
    s.append((_poly(outer), ORANGE, 0))
    s.append((_poly(outer), BLACK, 13))
    inner = _bezier((540, 780), (620, 880), (640, 1000), (600, 1120), 16)
    inner += _bezier((600, 1120), (570, 1180), (510, 1180), (480, 1120), 12)
    inner += _bezier((480, 1120), (440, 1010), (470, 870), (540, 780), 16)
    s.append((_poly(inner), HONEY, 0))
    s.append((_poly(inner), BLACK, 9))
    return s


def scene_factory():
    """Fabrika (üretim, sanayi, kirlilik)."""
    s = []
    s.append((_rect(220, 900, 860, 1300), BLACK, 13))
    for x in (300, 430, 560):
        s.append((_rect(x, 620, x + 90, 900), BLACK, 12))
        s.append((_ellipse(x + 45, 600, 60, 24), GRAY, 0))
        s.append((_ellipse(x + 45, 600, 60, 24), BLACK, 8))
    # Duman
    for cx, cy, r in [(360, 500, 55), (470, 430, 45), (600, 480, 60), (700, 400, 40)]:
        s.append((_ellipse(cx, cy, r, r * 0.8), (200, 200, 198), 0))
        s.append((_ellipse(cx, cy, r, r * 0.8), BLACK, 8))
    # Kapı ve pencereler
    s.append((_rect(480, 1080, 600, 1300), BLACK, 11))
    for x in (290, 700):
        s.append((_rect(x, 980, x + 90, 1070), SKY, 0))
        s.append((_rect(x, 980, x + 90, 1070), BLACK, 9))
    return s


def scene_cloud_rain():
    """Bulut ve yağmur (hava durumu, iklim)."""
    s = []
    cloud = _bezier((330, 800), (296, 700), (356, 618), (440, 644), 14)
    cloud += _bezier((440, 644), (452, 512), (602, 496), (654, 604), 14)
    cloud += _bezier((654, 604), (724, 556), (792, 620), (770, 704), 12)
    cloud += _bezier((770, 704), (818, 762), (786, 812), (716, 800), 10)
    cloud += _line((716, 800), (330, 800), 6)
    s.append((cloud, (228, 233, 236), 0))
    s.append((cloud, BLACK, 12))
    # Yağmur damlaları
    for i, x in enumerate((400, 500, 600, 700)):
        y = 900 if i % 2 == 0 else 960
        s.append((_drop(x, y, 46, 96), SKY, 0))
        s.append((_drop(x, y, 46, 96), BLACK, 8))
        s.append((_drop(x + 18, y + 170, 40, 84), SKY, 0))
        s.append((_drop(x + 18, y + 170, 40, 84), BLACK, 8))
    return s


def scene_shopping():
    """Alışveriş çantası + madeni para (fiyat, tüketim)."""
    s = []
    s.append((_rect(360, 720, 760, 1260), HONEY, 0))
    s.append((_rect(360, 720, 760, 1260), BLACK, 13))
    # Sap
    s.append((_bezier((470, 720), (470, 600), (650, 600), (650, 720), 18), BLACK, 12))
    # Etiket
    s.append((_rect(470, 900, 650, 1080), (255, 255, 255), 0))
    s.append((_rect(470, 900, 650, 1080), BLACK, 10))
    s.append((_line((510, 960), (610, 960)), BLACK, 8))
    s.append((_line((510, 1010), (580, 1010)), BLACK, 8))
    # Para
    s.append((_ellipse(800, 1140, 90, 90), HONEY, 0))
    s.append((_ellipse(800, 1140, 90, 90), BLACK, 11))
    s.append((_line((800, 1090), (800, 1190)), BLACK, 9))
    return s



def scene_sky():
    """Ufuk + güneş + bulutlar (gökyüzü, gündüz, ufuk)."""
    s = [(_line((90, 1120), (990, 1120), 20), BLACK, 11)]
    s.append((_ellipse(760, 720, 130, 130), HONEY, 0))
    s.append((_ellipse(760, 720, 130, 130), BLACK, 12))
    for a in range(0, 360, 45):
        rad = math.radians(a)
        s.append((_line((760 + 165 * math.cos(rad), 720 + 165 * math.sin(rad)),
                        (760 + 225 * math.cos(rad), 720 + 225 * math.sin(rad))), BLACK, 9))
    for cx, cy, r in [(280, 780, 70), (370, 720, 90), (470, 780, 65),
                      (330, 900, 60), (520, 880, 55)]:
        s.append((_ellipse(cx, cy, r, r * 0.65), (235, 238, 240), 0))
        s.append((_ellipse(cx, cy, r, r * 0.65), BLACK, 9))
    return s


def scene_rainbow():
    """Gökkuşağı (renkler, ışık, spektrum)."""
    s = []
    colors = [(214, 74, 70), (226, 146, 52), (232, 196, 66), (92, 168, 96), (74, 126, 200)]
    for i, color in enumerate(colors):
        r = 400 - i * 34
        arc = [(540 + r * math.cos(math.radians(a)), 1180 - r * math.sin(math.radians(a)))
               for a in range(0, 181, 4)]
        s.append((arc, color, 0))
        s.append((arc, BLACK, 7))
    s.append((_ellipse(200, 1180, 80, 55), (235, 238, 240), 0))
    s.append((_ellipse(200, 1180, 80, 55), BLACK, 9))
    s.append((_ellipse(880, 1180, 80, 55), (235, 238, 240), 0))
    s.append((_ellipse(880, 1180, 80, 55), BLACK, 9))
    return s


def scene_planet():
    """Gezegen (dünya, uzay, astronomi)."""
    s = []
    s.append((_ellipse(520, 900, 230, 230), SKY, 0))
    s.append((_ellipse(520, 900, 230, 230), BLACK, 13))
    for cx, cy, r in [(450, 830, 46), (610, 960, 38), (470, 1010, 30), (600, 800, 26)]:
        s.append((_ellipse(cx, cy, r, r * 0.9), (150, 196, 228), 0))
        s.append((_ellipse(cx, cy, r, r * 0.9), BLACK, 8))
    # Yörünge ve küçük uydu
    orbit = [(520 + 330 * math.cos(math.radians(a)), 900 + 120 * math.sin(math.radians(a)))
             for a in range(0, 360, 6)]
    s.append((orbit + [orbit[0]], BLACK, 8))
    s.append((_ellipse(820, 830, 42, 42), GRAY, 0))
    s.append((_ellipse(820, 830, 42, 42), BLACK, 9))
    return s



def scene_coffee():
    """Kahve fincanı (kahve, çekirdek, kafein, sabah rutini)."""
    s = []
    # Fincan gövdesi (U biçimli)
    body = [(320, 900)]
    body += _bezier((320, 900), (300, 1080), (400, 1180), (540, 1180), 16)
    body += _bezier((540, 1180), (680, 1180), (780, 1080), (760, 900), 16)
    s.append((body + [(320, 900)], BLACK, 14))
    # Ağız (elips) ve kahve yüzeyi
    s.append((_ellipse(540, 900, 220, 52), BLACK, 13))
    s.append((_ellipse(540, 905, 186, 36), BREAD_DARK, 0))
    # Kulp
    handle = []
    for a in range(-70, 71, 6):
        rad = math.radians(a)
        handle.append((740 + 120 * math.cos(rad), 1010 + 110 * math.sin(rad)))
    s.append((handle, BLACK, 12))
    # Buhar
    for dx in (-90, 0, 90):
        steam = [(540 + dx + 16 * math.sin(i / 3.0), 820 - i * 9) for i in range(0, 14)]
        s.append((steam, BLACK, 8))
    # Çekirdekler
    for cx, cy, rot in [(250, 1280, 20), (360, 1330, -15), (830, 1270, 10)]:
        bean = _ellipse(cx, cy, 52, 40)
        bean = [((x - cx) * math.cos(math.radians(rot)) - (y - cy) * math.sin(math.radians(rot)) + cx,
                 (x - cx) * math.sin(math.radians(rot)) + (y - cy) * math.cos(math.radians(rot)) + cy)
                for x, y in bean]
        s.append((bean, BREAD_DARK, 0))
        s.append((bean, BLACK, 10))
        s.append((_line((cx - 22, cy), (cx + 22, cy)), BLACK, 8))
    return s



def scene_lightbulb():
    """Ampul (fikir, elektrik, icat)."""
    s = []
    s.append((_ellipse(540, 820, 170, 170), HONEY, 0))
    s.append((_ellipse(540, 820, 170, 170), BLACK, 13))
    # duy (base)
    s.append((_poly([(470, 980), (610, 980), (600, 1090), (480, 1090)]), BLACK, 12))
    for y in (1020, 1060):
        s.append((_line((482, y), (598, y), 12), BLACK, 8))
    # filament
    s.append(([(430, 850), (480, 780), (520, 860), (560, 780), (610, 850)], BLACK, 8))
    s.append((_line((480, 780), (480, 950), 8), BLACK, 6))
    s.append((_line((600, 780), (600, 950), 8), BLACK, 6))
    # ışınlar
    for a in range(-70, 71, 20):
        rad = math.radians(a - 90)
        s.append((_line((540 + 215 * math.cos(rad), 820 + 215 * math.sin(rad)),
                        (540 + 300 * math.cos(rad), 820 + 300 * math.sin(rad)), 10), BLACK, 10))
    return s


def scene_battery():
    """Pil / şarj (enerji, batarya, tükenme)."""
    s = []
    # Yatay pil gövdesi + artı kutup
    s.append((_rect(220, 780, 820, 1140), BLACK, 14))
    s.append((_rect(820, 880, 900, 1040), BLACK, 12))
    # iç dolgu (enerji seviyesi)
    s.append((_rect(250, 810, 760, 1110), GREEN, 0))
    # " + " ve " - " işaretleri
    s.append((_line((300, 700), (360, 700), 12), BLACK, 10))
    s.append((_line((330, 670), (330, 730), 12), BLACK, 10))
    s.append((_line((300, 1210), (360, 1210), 12), BLACK, 10))
    # şimşek (şarj)
    bolt = [(560, 800), (470, 970), (545, 970), (505, 1120), (650, 930), (570, 930)]
    s.append((_poly(bolt), HONEY, 0))
    s.append((_poly(bolt), BLACK, 10))
    return s


def scene_tree():
    """Ağaç (doğa, orman, oksijen, çevre)."""
    s = [(_poly([(500, 1400), (520, 1080), (560, 1080), (580, 1400)]), BREAD_DARK, 0),
         (_poly([(500, 1400), (520, 1080), (560, 1080), (580, 1400)]), BLACK, 12)]
    for cx, cy, r in [(430, 900, 150), (650, 900, 150), (540, 760, 170), (540, 980, 130)]:
        s.append((_ellipse(cx, cy, r, r * 0.85), GREEN, 0))
        s.append((_ellipse(cx, cy, r, r * 0.85), BLACK, 11))
    s.append((_line((360, 1430), (720, 1430), 20), BLACK, 12))
    return s


def scene_car():
    """Araba (ulaşım, kış, yol, trafik)."""
    s = [(_poly([(220, 1080), (260, 940), (380, 920), (450, 820), (700, 820),
                 (790, 920), (880, 940), (900, 1080)]), SKY, 0),
         (_poly([(220, 1080), (260, 940), (380, 920), (450, 820), (700, 820),
                 (790, 920), (880, 940), (900, 1080)]), BLACK, 13),
         (_ellipse(400, 1090, 80, 80), BLACK, 12),
         (_ellipse(760, 1090, 80, 80), BLACK, 12),
         (_ellipse(400, 1090, 34, 34), GRAY, 0),
         (_ellipse(760, 1090, 34, 34), GRAY, 0),
         (_poly([(470, 900), (520, 840), (640, 840), (640, 900)]), (235, 238, 240), 0),
         (_poly([(470, 900), (520, 840), (640, 840), (640, 900)]), BLACK, 9),
         (_line((200, 1150), (920, 1150), 30), BLACK, 10)]
    return s


def scene_rocket():
    """Roket (uzay, hız, teknoloji, keşif)."""
    s = [(_poly([(540, 520), (620, 700), (620, 1120), (460, 1120), (460, 700)]), (235, 238, 240), 0),
         (_poly([(540, 520), (620, 700), (620, 1120), (460, 1120), (460, 700)]), BLACK, 13)]
    s.append((_ellipse(540, 820, 60, 60), SKY, 0))
    s.append((_ellipse(540, 820, 60, 60), BLACK, 10))
    s.append((_poly([(460, 960), (360, 1120), (460, 1100)]), RED, 0))
    s.append((_poly([(460, 960), (360, 1120), (460, 1100)]), BLACK, 11))
    s.append((_poly([(620, 960), (720, 1120), (620, 1100)]), RED, 0))
    s.append((_poly([(620, 960), (720, 1120), (620, 1100)]), BLACK, 11))
    flame = [(500, 1120), (540, 1300), (580, 1120)]
    s.append((flame, HONEY, 0))
    s.append((flame, BLACK, 10))
    return s


def scene_brain():
    """Beyin (düşünce, öğrenme, hafıza)."""
    s = []
    left = _bezier((540, 640), (380, 600), (300, 800), (400, 900), 20)
    left += _bezier((400, 900), (320, 1000), (420, 1180), (540, 1120), 20)
    right = _bezier((540, 640), (700, 600), (780, 800), (680, 900), 20)
    right += _bezier((680, 900), (760, 1000), (660, 1180), (540, 1120), 20)
    s.append((left, (238, 206, 208), 0))
    s.append((right, (238, 206, 208), 0))
    s.append((left + right, BLACK, 14))
    s.append((_line((540, 650), (540, 1110), 26), BLACK, 10))
    squiggle = []
    for i in range(0, 40):
        squiggle.append((420 + 8 * i, 820 + 55 * math.sin(i / 2.4)))
    s.append((squiggle, BLACK, 8))
    squiggle2 = [(x + 20, y + 150) for x, y in squiggle]
    s.append(([(x - 40, y) for x, y in squiggle2], BLACK, 8))
    return s


def scene_map():
    """Harita (yol, konum, seyahat, keşif)."""
    s = [(_poly([(180, 760), (420, 690), (660, 770), (900, 700), (900, 1220),
                 (660, 1290), (420, 1210), (180, 1280)]), (243, 240, 232), 0),
         (_poly([(180, 760), (420, 690), (660, 770), (900, 700), (900, 1220),
                 (660, 1290), (420, 1210), (180, 1280)]), BLACK, 13),
         (_line((420, 700), (420, 1205), 20), BLACK, 9),
         (_line((660, 775), (660, 1285), 20), BLACK, 9)]
    # rota: yumuşak bir eğri
    route = _bezier((250, 1180), (380, 1120), (420, 1000), (540, 980), 18)
    route += _bezier((540, 980), (660, 960), (700, 900), (800, 870), 18)
    s.append((route, RED, 0))
    s.append((route, BLACK, 8))
    # konum iğnesi (damla biçimi) + iç nokta
    pin = _bezier((800, 700), (720, 700), (700, 790), (760, 840), 16)
    pin += _bezier((760, 840), (810, 800), (860, 760), (800, 700), 16)
    s.append((pin, RED, 0))
    s.append((pin, BLACK, 10))
    s.append((_ellipse(795, 760, 22, 22), (243, 240, 232), 0))
    s.append((_ellipse(795, 760, 22, 22), BLACK, 8))
    return s


def scene_thermometer():
    """Termometre (sıcaklık, ateş, iklim)."""
    s = [(_ellipse(540, 1180, 90, 90), RED, 0),
         (_ellipse(540, 1180, 90, 90), BLACK, 12),
         (_poly([(490, 1120), (490, 640), (590, 640), (590, 1120)]), (240, 240, 240), 0),
         (_poly([(490, 1120), (490, 640), (590, 640), (590, 1120)]), BLACK, 12),
         (_poly([(515, 1100), (515, 700), (565, 700), (565, 1100)]), RED, 0)]
    for i in range(6):
        y = 700 + i * 78
        s.append((_line((600, y), (650, y), 8), BLACK, 7))
    return s



def scene_person():
    """Tek figür: çizgi film insanı (anlatan, bakan, düşünen)."""
    head = _ellipse(0, -120, 46, 52, 28)
    body = [(0, -68), (0, 45)]
    arms = [(-62, 0), (0, -28), (62, 0)]
    return [(head, BLACK, 13),
            (body, BLACK, 14),
            (arms, BLACK, 12),
            ([(-52, 155), (0, 45)], BLACK, 13),
            ([(0, 45), (52, 155)], BLACK, 13),
            (_ellipse(-16, -128, 6, 6, 10), BLACK, 0),
            (_ellipse(16, -128, 6, 6, 10), BLACK, 0),
            (_bezier((-18, -104), (-6, -96), (6, -96), (18, -104), 10), BLACK, 6)]


def scene_two_people():
    """İki figür: konuşan/karşılaştıran iki insan."""
    a_head = _ellipse(-70, -110, 40, 46, 26)
    b_head = _ellipse(78, -96, 40, 46, 26)
    return [(a_head, BLACK, 12),
            ([( -70, -64), (-70, 50)], BLACK, 13),
            ([(-118, -16), (10, -16)], BLACK, 11),
            ([(-112, 168), (-70, 50)], BLACK, 12),
            ([(-70, 50), (-28, 168)], BLACK, 12),
            (b_head, BLACK, 12),
            ([(78, -50), (78, 60)], BLACK, 13),
            ([(26, 4), (150, 4)], BLACK, 11),
            ([(38, 178), (78, 60)], BLACK, 12),
            ([(78, 60), (118, 178)], BLACK, 12)]


def scene_arrow_up():
    """Yukarı ok (artış, yükselme, iyileşme)."""
    return [(_line((0, 180), (0, -170), 26), BLACK, 16),
            ([(-95, -70), (0, -185), (95, -70)], BLACK, 16)]


def scene_arrow_down():
    """Aşağı ok (azalma, düşüş, kayıp)."""
    return [(_line((0, -180), (0, 170), 26), BLACK, 16),
            ([(-95, 70), (0, 185), (95, 70)], BLACK, 16)]


def scene_bubble():
    """Konuşma balonu (söylenti, açıklama, iletişim)."""
    body = _bezier((-190, -140), (-60, -210), (80, -210), (190, -140), 26) + \
        _bezier((190, -140), (250, -40), (200, 120), (60, 150), 20) + \
        _bezier((60, 150), (-40, 168), (-150, 140), (-190, 40), 20) + \
        _bezier((-190, 40), (-230, -50), (-260, -90), (-190, -140), 14)
    tail = [(-70, 140), (-110, 240), (0, 160)]
    return [(body, BLACK, 13),
            (_poly(tail), BLACK, 12),
            (_line((-110, -60), (110, -60), 14), BLACK, 9),
            (_line((-110, -10), (80, -10), 12), BLACK, 9),
            (_line((-110, 40), (30, 40), 10), BLACK, 9)]


def scene_star():
    """Yıldız (parlaklık, hedef, başarı)."""
    pts = []
    for i in range(10):
        angle = math.pi / 2 + i * math.pi / 5
        r = 210 if i % 2 == 0 else 88
        pts.append((r * math.cos(angle), -r * math.sin(angle)))
    return [(_poly(pts), (240, 200, 70), 10),
            (_poly(pts), BLACK, 12)]


def scene_magnifier():
    """Büyüteç (inceleme, arama, kanıt)."""
    lens = _ellipse(-40, -80, 150, 150, 44)
    handle = [(-40 + 106, -80 + 106), (170, 230)]
    return [(lens, BLACK, 15),
            (handle, BLACK, 20),
            (_ellipse(-90, -130, 44, 44, 26), (200, 230, 250), 0),
            (_bezier((-160, -150), (-120, -200), (-40, -210), (10, -190), 16), (200, 230, 250), 10)]


def scene_gear():
    """Dişli çark (sistem, ayar, mekanizma)."""
    ring = _ellipse(0, 0, 150, 150, 48)
    inner = _ellipse(0, 0, 58, 58, 24)
    s = [(ring, BLACK, 14), (inner, BLACK, 12)]
    for i in range(8):
        angle = i * math.pi / 4
        x1, y1 = 150 * math.cos(angle), 150 * math.sin(angle)
        x2, y2 = 205 * math.cos(angle), 205 * math.sin(angle)
        s.append((_line((x1, y1), (x2, y2), 10), BLACK, 16))
    return s


def scene_ice():
    """Buz küpü (soğuk, donma, buz)."""
    top = [(420, 700), (660, 640), (820, 720), (580, 790)]
    left = [(420, 700), (580, 790), (580, 1080), (420, 990)]
    right = [(580, 790), (820, 720), (820, 1010), (580, 1080)]
    s = [_fill_poly(top, (214, 238, 248)),
         _fill_poly(left, (188, 222, 240)),
         _fill_poly(right, (232, 246, 252)),
         (_poly(top), BLACK, 12),
         (_poly(left), BLACK, 12),
         (_poly(right), BLACK, 12),
         (_poly([(470, 760), (520, 800), (505, 870)]), BLACK, 7)]
    for i in range(3):
        x = 340 + i * 26
        s.append((_line((x, 1160 + i * 18), (x + 120, 1120 + i * 18), 10), SKY, 7))
    return s


def scene_salt():
    """Tuzluk ve dökülen tuz (tuz, deniz, tat)."""
    body = [(430, 760), (650, 760), (690, 1180), (390, 1180)]
    cap = [(410, 660), (670, 660), (660, 760), (420, 760)]
    s = [_fill_poly(body, (245, 245, 245)),
         (_poly(body), BLACK, 13),
         (_poly(cap), GRAY, 0),
         (_poly(cap), BLACK, 13)]
    for i in range(3):
        x = 485 + i * 55
        s.append((_ellipse(x, 700, 16, 16, 16), BLACK, 8))
    for i, (x, y) in enumerate([(470, 560), (540, 520), (610, 570), (500, 470), (580, 450)]):
        s.append((_ellipse(x, y, 9, 9, 12), BLACK, 0))
    return s


def scene_eye():
    """Göz (bakış, görme, dikkat)."""
    upper = _bezier((300, 900), (420, 740), (660, 740), (780, 900), 32)
    lower = _bezier((780, 900), (660, 1060), (420, 1060), (300, 900), 32)
    return [(upper, BLACK, 14),
            (lower, BLACK, 14),
            (_ellipse(540, 900, 105, 105, 40), (120, 170, 220), 0),
            (_ellipse(540, 900, 105, 105, 40), BLACK, 12),
            (_ellipse(540, 900, 44, 44, 24), BLACK, 0),
            (_line((300, 900), (200, 860), 10), BLACK, 8),
            (_line((780, 900), (880, 860), 10), BLACK, 8),
            (_line((470, 720), (450, 640), 8), BLACK, 7),
            (_line((540, 715), (540, 630), 8), BLACK, 7),
            (_line((610, 720), (630, 640), 8), BLACK, 7)]


def scene_ear():
    """Kulak ve ses dalgaları (duyma, ses, gürültü)."""
    outer = _bezier((470, 700), (760, 700), (800, 1080), (600, 1150), 28) + \
        _bezier((600, 1150), (470, 1200), (400, 1060), (470, 960), 20)
    inner = _bezier((500, 830), (640, 820), (640, 960), (545, 985), 18)
    s = [(outer, BLACK, 14),
         (inner, BLACK, 11),
         (_ellipse(520, 930, 32, 46, 20), BLACK, 0)]
    for i in range(3):
        r = 130 + i * 62
        arc = _ellipse(760, 900, r, r, 30, start=-0.65, end=0.65)
        s.append((arc, BLACK, 8))
    return s


def scene_key():
    """Anahtar (kilit, çözüm, erişim)."""
    s = [(_ellipse(420, 880, 130, 130, 40), BLACK, 14),
         (_ellipse(420, 880, 58, 58, 24), BLACK, 11),
         (_line((548, 880), (900, 880), 30), BLACK, 16)]
    for dx in (740, 820):
        s.append((_line((dx, 880), (dx, 990), 10), BLACK, 14))
    s.append((_line((900, 880), (900, 960), 10), BLACK, 14))
    return s


def scene_ladder():
    """Merdiven (yükselme, hedef, adım)."""
    s = [(_line((380, 1250), (480, 620), 30), BLACK, 15),
         (_line((700, 1250), (800, 620), 30), BLACK, 15)]
    for i in range(5):
        y = 700 + i * 130
        s.append((_line((372 + i * 20, y + 40), (692 + i * 20, y + 40), 20), BLACK, 12))
    return s


def scene_bridge():
    """Köprü (bağlantı, geçiş, iki yakayı birleştirme)."""
    deck = _bezier((250, 980), (450, 830), (630, 830), (830, 980), 30)
    s = [(deck, BLACK, 16),
         (_line((250, 980), (250, 1080), 12), BLACK, 12),
         (_line((830, 980), (830, 1080), 12), BLACK, 12),
         (_line((380, 902), (380, 1050), 12), BLACK, 12),
         (_line((700, 902), (700, 1050), 12), BLACK, 12)]
    for i in range(4):
        x = 380 + i * 106
        s.append((_line((x, 880 if i in (1, 2) else 900), (x, 830), 8), BLACK, 7))
    for i in range(3):
        y = 1120 + i * 30
        s.append((_line((250, y), (420, y), 12), SKY, 7))
        s.append((_line((660, y), (830, y), 12), SKY, 7))
    return s


def scene_boat():
    """Tekne/yelkenli (deniz, yolculuk, ticaret)."""
    hull = [(330, 1050), (750, 1050), (690, 1170), (390, 1170)]
    sail = [(560, 720), (560, 1010), (760, 1010)]
    return [_fill_poly(hull, (208, 168, 120)),
            (_poly(hull), BLACK, 13),
            (_line((560, 690), (560, 1030), 14), BLACK, 13),
            _fill_poly(sail, (240, 240, 240)),
            (_poly(sail), BLACK, 12),
            (_bezier((250, 1220), (420, 1180), (560, 1260), (720, 1210), 20), SKY, 9),
            (_bezier((300, 1270), (460, 1230), (600, 1300), (760, 1250), 20), SKY, 9)]


def scene_airplane():
    """Uçak (uçuş, seyahat, hız)."""
    body = _bezier((250, 900), (420, 820), (700, 840), (850, 900), 26) + \
        _bezier((850, 900), (700, 960), (420, 980), (250, 900), 26)
    wing = [(470, 930), (330, 1120), (470, 1120), (600, 950)]
    tail = [(760, 880), (880, 730), (890, 890)]
    s = [(body, BLACK, 14),
         _fill_poly(wing, (214, 232, 248)),
         (_poly(wing), BLACK, 12),
         _fill_poly(tail, (214, 232, 248)),
         (_poly(tail), BLACK, 12),
         (_ellipse(330, 890, 34, 26, 18), SKY, 0),
         (_line((250, 890), (200, 890), 8), BLACK, 8)]
    for i in range(3):
        s.append((_bezier((180 - i * 40, 1010), (300 - i * 40, 980),
                          (420 - i * 40, 1040), (560 - i * 40, 1010), 18), GRAY, 6))
    return s


def scene_calendar():
    """Takvim (gün, tarih, plan)."""
    s = [(_rect(300, 640, 780, 1180), BLACK, 14),
         (_line((300, 780), (780, 780), 12), BLACK, 12),
         (_line((300, 640), (780, 640), 12), BLACK, 14)]
    for x in (400, 680):
        s.append((_line((x, 600), (x, 700), 12), BLACK, 10))
    for row in range(3):
        for col in range(4):
            cx = 370 + col * 120
            cy = 840 + row * 110
            s.append((_ellipse(cx, cy, 16, 16, 14), BLACK, 0))
    s.append((_ellipse(490, 950, 78, 78, 30), RED, 9))
    return s


def scene_moon():
    """Ay ve yıldızlar (gece, uyku, döngü)."""
    crescent = _ellipse(520, 900, 190, 190, 44, start=0.6, end=5.7)
    s = [(crescent, (236, 210, 122), 22),
         (_ellipse(300, 760, 26, 26, 16), BLACK, 8),
         (_ellipse(740, 1050, 20, 20, 14), BLACK, 8)]
    for (x, y, r) in ((760, 720, 34), (330, 1080, 26), (860, 940, 22)):
        s.append(([(x - r, y), (x + r, y)], BLACK, 7))
        s.append(([(x, y - r), (x, y + r)], BLACK, 7))
    return s


def scene_magnet():
    """Mıknatıs (çekim, manyetizma, etki)."""
    outer = ((420, 700), (420, 980), (660, 980), (660, 700))
    s = [(_line(outer[0], outer[1], 24), BLACK, 16),
         (_bezier(outer[1], (420, 1100), (660, 1100), outer[2], 26), BLACK, 16),
         (_line(outer[2], outer[3], 24), BLACK, 16),
         (_line((430, 700), (430, 830), 12), RED, 13),
         (_line((650, 700), (650, 830), 12), (66, 133, 199), 13)]
    for i in range(3):
        r = 210 + i * 70
        s.append((_ellipse(540, 900, r, r, 34, start=-0.5, end=0.5), GRAY, 6))
    return s


def scene_leaf():
    """Yaprak (bitki, doğa, mevsim)."""
    leaf = _bezier((420, 1180), (300, 900), (520, 660), (780, 620), 28) + \
        _bezier((780, 620), (760, 880), (600, 1130), (420, 1180), 28)
    s = [(leaf, GREEN, 13),
         (_line((420, 1180), (770, 630), 24), BLACK, 10)]
    for i in range(4):
        t = 0.22 + i * 0.16
        x = 420 + (770 - 420) * t
        y = 1180 - (1180 - 630) * t
        s.append((_line((x, y), (x + 110, y - 40), 10), BLACK, 6))
        s.append((_line((x, y), (x + 60, y + 70), 10), BLACK, 6))
    return s


def scene_road():
    """Yol (hedef, süreç, yolculuk): çapraz uzanan yol ve kesik şerit."""
    # Yol, sol-alt köşeden sağ-üst köşeye uzanan bir bant olarak çizilir
    ux, uy = 0.7071, -0.7071          # yol yönü
    nx, ny = -uy, ux                  # yola dik yön
    half = 120.0
    start_pt = (-360.0, 300.0)
    end_pt = (330.0, -300.0)

    def edge(offset):
        p1 = (start_pt[0] + nx * offset, start_pt[1] + ny * offset)
        p2 = (end_pt[0] + nx * offset, end_pt[1] + ny * offset)
        return _line(p1, p2, 28)

    s = [(edge(half), BLACK, 15), (edge(-half), BLACK, 15)]

    # Orta şerit: 4 kesik çizgi
    for i in range(4):
        t = 0.12 + i * 0.24
        cx = start_pt[0] + (end_pt[0] - start_pt[0]) * t
        cy = start_pt[1] + (end_pt[1] - start_pt[1]) * t
        length = 90.0
        p1 = (cx - ux * length / 2, cy - uy * length / 2)
        p2 = (cx + ux * length / 2, cy + uy * length / 2)
        s.append((_line(p1, p2, 10), BLACK, 13))
    return s


SCENES = {
    "egyptian_vase": scene_egyptian_vase,
    "honey_pot": scene_honey_pot,
    "milk_bread_honey": scene_milk_bread_honey,
    "water_drop": scene_water_drop,
    "bacteria_honey": scene_bacteria_honey,
    "question": scene_question,
    "clock": scene_clock,
    "sun": scene_sun,
    "heart": scene_heart,
    "money": scene_money,
    "house": scene_house,
    "book": scene_book,
    "check": scene_check,
    "cross": scene_cross,
    "bee": scene_bee,
    "phone": scene_phone,
    "chart": scene_chart,
    "shield": scene_shield,
    "flame": scene_flame,
    "factory": scene_factory,
    "cloud_rain": scene_cloud_rain,
    "shopping": scene_shopping,
    "sky": scene_sky,
    "rainbow": scene_rainbow,
    "planet": scene_planet,
    "coffee": scene_coffee,
    "lightbulb": scene_lightbulb,
    "battery": scene_battery,
    "tree": scene_tree,
    "car": scene_car,
    "rocket": scene_rocket,
    "brain": scene_brain,
    "map": scene_map,
    "thermometer": scene_thermometer,
    "ice": scene_ice,
    "salt": scene_salt,
    "eye": scene_eye,
    "ear": scene_ear,
    "key": scene_key,
    "ladder": scene_ladder,
    "bridge": scene_bridge,
    "boat": scene_boat,
    "airplane": scene_airplane,
    "calendar": scene_calendar,
    "moon": scene_moon,
    "magnet": scene_magnet,
    "leaf": scene_leaf,
    "road": scene_road,
    "person": scene_person,
    "two_people": scene_two_people,
    "arrow_up": scene_arrow_up,
    "arrow_down": scene_arrow_down,
    "bubble": scene_bubble,
    "star": scene_star,
    "magnifier": scene_magnifier,
    "gear": scene_gear,
    "generic": scene_generic,
}


def pick_scene_for_text(text):
    """Türkçe metinden sahne seç (ScriptAgent sahne veremezse yedek)."""
    t = (text or "").lower()
    best, best_score = "generic", 0
    for scene_id, keywords in SCENE_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in t)
        if score > best_score:
            best, best_score = scene_id, score
    return best


# Çizim alanı: üstte boşluk, altta altyazı payı bırakılır
DRAW_BOX = (80.0, 340.0, 1000.0, 1590.0)


def _fit_scene(strokes, box=DRAW_BOX, max_scale=1.45):
    """Sahneyi çizim alanına oranlı biçimde sığdırır ve ortalar.

    Bu sayede her sahne kareyi benzer şekilde doldurur; hiçbir çizim
    kenardan taşmaz.
    """
    xs = [x for pts, _c, _w in strokes for x, y in pts]
    ys = [y for pts, _c, _w in strokes for x, y in pts]
    if not xs:
        return strokes

    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
    bw = max(1.0, max_x - min_x)
    bh = max(1.0, max_y - min_y)

    box_w = box[2] - box[0]
    box_h = box[3] - box[1]
    scale = min(box_w / bw, box_h / bh, max_scale)

    cx_src = (min_x + max_x) / 2
    cy_src = (min_y + max_y) / 2
    cx_dst = (box[0] + box[2]) / 2
    cy_dst = (box[1] + box[3]) / 2

    def transform(pt):
        return (cx_dst + (pt[0] - cx_src) * scale, cy_dst + (pt[1] - cy_src) * scale)

    # Çizgi kalınlığı ölçekle birlikte artsın: büyük nesnede ince çizgi kayboluyordu.
    width_scale = max(0.9, min(1.8, scale))
    out = []
    for pts, color, width in strokes:
        out.append(([transform(pt) for pt in pts], color, width * width_scale))
    return out


def render_object(object_id, box, seed=0):
    """Tek nesneyi verilen kutuya sığdırarak çizer (kompozisyon için)."""
    fn = SCENES.get(object_id)
    if fn is None:
        return []
    strokes = fn()
    jittered = [
        (_jitter(pts, amount=1.6, seed=seed * 13 + i * 7), color, width)
        for i, (pts, color, width) in enumerate(strokes)
    ]
    return _fit_scene(jittered, box, max_scale=6.0)


def compose(objects, box=DRAW_BOX):
    """Sahneyi 1-3 nesneden kurar.

    objects: [{"type": "person", "x": 0.3, "y": 0.6, "size": 0.45}, ...]
    x/y çizim alanına göre 0-1 oranı, size alanın ne kadarını kaplayacağı.
    """
    strokes = []
    for index, obj in enumerate(objects or []):
        object_id = (obj or {}).get("type")
        if object_id not in SCENES:
            continue
        cx = float(obj.get("x", 0.5))
        cy = float(obj.get("y", 0.5))
        size = float(obj.get("size", 0.66))
        # Küçük nesneler sayfayı boş bırakıyordu: alt sınır 0.40.
        size = max(0.40, min(0.98, size))
        # Kenara yapışmasın
        cx = max(0.16, min(0.84, cx))
        cy = max(0.18, min(0.82, cy))
        box_w = (box[2] - box[0]) * size
        box_h = (box[3] - box[1]) * size
        center_x = box[0] + (box[2] - box[0]) * max(0.0, min(1.0, cx))
        center_y = box[1] + (box[3] - box[1]) * max(0.0, min(1.0, cy))
        sub = (center_x - box_w / 2, center_y - box_h / 2,
               center_x + box_w / 2, center_y + box_h / 2)
        strokes.extend(render_object(object_id, sub, seed=index + 1))
    return strokes


def get_scene(scene_id):
    fn = SCENES.get(scene_id) or scene_generic
    strokes = fn()
    # Hafif el titremesi hissi (deterministik)
    jittered = [
        (_jitter(pts, amount=1.8, seed=i * 7 + 3), color, width)
        for i, (pts, color, width) in enumerate(strokes)
    ]
    return _fit_scene(jittered)
