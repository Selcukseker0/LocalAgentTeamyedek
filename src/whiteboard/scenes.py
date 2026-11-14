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
    "milk_bread_honey": ["süt", "sut", "ekmek", "bozul", "bozuk", "gıda", "gida"],
    "water_drop": ["su", "damla", "nem", "ıslak", "islak", "kuruma"],
    "bacteria_honey": ["bakteri", "mikrop", "kurut", "öldür", "oldur", "hastalık", "hastalik"],
    "question": ["neden", "nasıl", "nasil", "soru", "?", "merak"],
    "clock": ["saat", "zaman", "yıl", "yil", "gün", "gun", "süre", "sure"],
    "sun": ["güneş", "gunes", "sıcak", "sicak", "yaz"],
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


def _fit_scene(strokes, box=DRAW_BOX):
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
    scale = min(box_w / bw, box_h / bh, 1.45)

    cx_src = (min_x + max_x) / 2
    cy_src = (min_y + max_y) / 2
    cx_dst = (box[0] + box[2]) / 2
    cy_dst = (box[1] + box[3]) / 2

    def transform(pt):
        return (cx_dst + (pt[0] - cx_src) * scale, cy_dst + (pt[1] - cy_src) * scale)

    out = []
    for pts, color, width in strokes:
        out.append(([transform(pt) for pt in pts], color, width))
    return out


def get_scene(scene_id):
    fn = SCENES.get(scene_id) or scene_generic
    strokes = fn()
    # Hafif el titremesi hissi (deterministik)
    jittered = [
        (_jitter(pts, amount=1.8, seed=i * 7 + 3), color, width)
        for i, (pts, color, width) in enumerate(strokes)
    ]
    return _fit_scene(jittered)
