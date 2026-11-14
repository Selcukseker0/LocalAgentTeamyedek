"""Keçeli kalem (marker) görünümünü taklit eden çizim yardımcıları.

Vektör çizgileri gerçek marker gibi göstermek için:
  * değişken uç kalınlığı (basınç profili + el titremesi),
  * uç birikmesi (ink blob) ve hafif "çift geçiş" yumuşatma,
  * kâğıt dokusu, lif ve vinyet,
  * yarı saydam, bantlı (üst üste binen) renk dolguları.

Tüm çizimler kapalı çokgen olarak yapılır; bu sayede tek `polygon` çağrısı
ile kalınlığı değişen yumuşak bir çizgi elde edilir.
"""

import math
import random

from PIL import Image, ImageDraw, ImageFilter

PAPER = (252, 251, 249)
PAPER_SHADOW = (226, 226, 224)


# ------------------------------------------------------------------ geometri


def path_length(pts):
    return sum(math.hypot(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in zip(pts, pts[1:]))


def resample(pts, step):
    """Poliliniyi eşit aralıklı noktalara böler."""
    if len(pts) < 2:
        return list(pts)
    out = [pts[0]]
    acc = 0.0
    prev = pts[0]
    for nxt in pts[1:]:
        seg = math.hypot(nxt[0] - prev[0], nxt[1] - prev[1])
        if seg <= 1e-9:
            prev = nxt
            continue
        pos = step - acc
        while pos <= seg:
            t = pos / seg
            out.append((prev[0] + (nxt[0] - prev[0]) * t, prev[1] + (nxt[1] - prev[1]) * t))
            pos += step
        acc = (acc + seg) % step
        prev = nxt
    if out[-1] != pts[-1]:
        out.append(pts[-1])
    return out


def truncate(pts, progress):
    """Poliliniyi toplam uzunluğun `progress` kadarından keser."""
    if progress >= 1.0:
        return list(pts)
    if progress <= 0.0 or len(pts) < 2:
        return [pts[0]] if pts else []

    total = path_length(pts)
    target = total * progress
    acc = 0.0
    out = [pts[0]]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        seg = math.hypot(x2 - x1, y2 - y1)
        if acc + seg <= target:
            out.append((x2, y2))
            acc += seg
        else:
            t = (target - acc) / seg if seg else 0.0
            out.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
            break
    return out


def _normals(pts):
    """Her nokta için birim normal vektörü."""
    n = len(pts)
    normals = []
    for i in range(n):
        if i == 0:
            dx, dy = pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]
        elif i == n - 1:
            dx, dy = pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1]
        else:
            dx = pts[i + 1][0] - pts[i - 1][0]
            dy = pts[i + 1][1] - pts[i - 1][1]
        length = math.hypot(dx, dy) or 1.0
        normals.append((-dy / length, dx / length))
    return normals


def _pressure(n, base_width, seed=0):
    """Marker basınç profili: uçlarda incelir, ortada dolgun, hafif dalgalı."""
    rnd = random.Random(seed)
    wobble_phase = rnd.uniform(0, math.tau)
    wobble_amp = rnd.uniform(0.04, 0.11)
    widths = []
    for i in range(n):
        t = i / max(1, n - 1)
        if t < 0.12:
            taper = 0.55 + 0.45 * (t / 0.12)
        elif t > 0.88:
            taper = 0.62 + 0.38 * ((1 - t) / 0.12)
        else:
            taper = 1.0
        wobble = 1.0 + wobble_amp * math.sin(wobble_phase + t * math.tau * 1.7)
        widths.append(base_width * taper * wobble)
    return widths


def stroke_polygon(pts, base_width, seed=0, step=None):
    """Kalınlığı değişen çizgiyi kapalı çokgen olarak döndürür."""
    if len(pts) < 2:
        return None
    step = step or max(3.0, base_width * 0.55)
    pts = resample(pts, step)
    if len(pts) < 2:
        return None

    widths = _pressure(len(pts), base_width, seed)
    normals = _normals(pts)

    left = []
    right = []
    for (x, y), (nx, ny), w in zip(pts, normals, widths):
        half = w / 2.0
        left.append((x + nx * half, y + ny * half))
        right.append((x - nx * half, y - ny * half))
    return left + right[::-1]


# ------------------------------------------------------------------ kağıt


def make_paper(w, h, seed=7):
    """Beyaz kâğıt: ince grain, lif dokusu, hafif vinyet ve alt gölge."""
    rnd = random.Random(seed)
    img = Image.new("RGB", (w, h), PAPER)
    draw = ImageDraw.Draw(img)

    # Alt tarafta yumuşak gölge (kâğıdın masaya oturması)
    shade_h = int(h * 0.16)
    for i in range(shade_h):
        y = h - shade_h + i
        k = (i / shade_h) ** 2
        tone = tuple(int(PAPER[c] * (1 - k) + PAPER_SHADOW[c] * k) for c in range(3))
        draw.line([(0, y), (w, y)], fill=tone)

    # Grain (hafif kâğıt kumlanması)
    grain = Image.effect_noise((w, h), 14).convert("L").filter(ImageFilter.GaussianBlur(0.4))
    grain_alpha = grain.point(lambda v: int(max(0, abs(v - 128) - 12) * 0.55))
    img = Image.composite(
        Image.new("RGB", (w, h), (255, 255, 255)), img, grain_alpha
    )

    # Kâğıt lifleri
    fibers = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fibers)
    for _ in range(int(w * h / 52000)):
        x, y = rnd.uniform(0, w), rnd.uniform(0, h)
        length = rnd.uniform(w * 0.01, w * 0.05)
        angle = rnd.uniform(-0.35, 0.35)
        fd.line(
            [(x, y), (x + length * math.cos(angle), y + length * math.sin(angle))],
            fill=(190, 188, 182, rnd.randint(10, 24)),
            width=1,
        )
    img = Image.alpha_composite(img.convert("RGBA"), fibers).convert("RGB")

    # Vinyet (kenarlara doğru çok hafif kararma)
    small = Image.radial_gradient("L").resize((w, h), Image.BILINEAR)
    vignette = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    vignette.putalpha(small.point(lambda v: int(max(0, v - 205) * 0.30)))
    img = Image.alpha_composite(img.convert("RGBA"), vignette).convert("RGB")
    return img


# ------------------------------------------------------------------ dolgular


def make_fill(bbox, polygon, color, seed=0, scale=1.0):
    """Marker ile boyanmış yarı saydam, bantlı dolgu görseli üretir.

    Döndürür: (x, y, RGBA görsel) — görsel kendi bbox'ı kadar.
    """
    x0, y0, x1, y1 = bbox
    bw, bh = max(1, int(x1 - x0)), max(1, int(y1 - y0))
    local = [(px - x0, py - y0) for px, py in polygon]

    # Şeklin maskesi (kenarlarda 2-3 px taşma: marker dışarı taşar)
    mask = Image.new("L", (bw, bh), 0)
    md = ImageDraw.Draw(mask)
    md.polygon(local, fill=255)
    if scale > 0:
        mask = mask.filter(ImageFilter.MaxFilter(5))

    base = Image.new("RGBA", (bw, bh), color + (0,))
    base.putalpha(mask.point(lambda v: int(v * 0.80)))

    # Üst üste binen marker bantları
    bands = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bands)
    rnd = random.Random(seed)
    dark = tuple(max(0, int(c * 0.82)) for c in color)
    spacing = max(9.0, bw / 26.0)
    span = bw + bh
    x = -bh
    while x < span:
        alpha = rnd.randint(16, 34)
        bd.line([(x, 0), (x + bh * 0.55, bh)], fill=dark + (alpha,), width=int(spacing * 0.55))
        x += spacing
    bands.putalpha(Image.composite(bands.getchannel("A"), Image.new("L", (bw, bh), 0), mask))

    fill = Image.alpha_composite(base, bands)

    # Kenarda hafif koyulaşma (mürekkep birikmesi)
    edge = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    ed = ImageDraw.Draw(edge)
    ed.polygon(local, outline=tuple(int(c * 0.88) for c in color) + (70,), width=3)
    fill = Image.alpha_composite(fill, edge)
    # Dar ve uzun şekillerde dolgu yukarıdan aşağı sürülür
    axis = "y" if bh > bw * 1.35 else "x"
    return (int(x0), int(y0), fill, axis)


def draw_fill_reveal(frame, fill_sprite, progress):
    """Dolguyu marker sürüyormuş gibi açar (baskın eksende ilerler)."""
    x, y, sprite = fill_sprite[0], fill_sprite[1], fill_sprite[2]
    axis = fill_sprite[3] if len(fill_sprite) > 3 else "x"
    if progress <= 0:
        return
    if axis == "y":
        cut = int(sprite.height * min(1.0, progress))
        if cut <= 0:
            return
        part = sprite.crop((0, 0, sprite.width, cut))
        frame.alpha_composite(part, (x, y))
        return
    cut = int(sprite.width * min(1.0, progress))
    if cut <= 0:
        return
    part = sprite.crop((0, 0, cut, sprite.height))
    frame.alpha_composite(part, (x, y))


def ink_blob(draw, point, width, color, seed=0):
    """Çizgi başında/ucunda mürekkep birikmesi."""
    rnd = random.Random(seed)
    r = max(1.0, width * rnd.uniform(0.55, 0.75))
    draw.ellipse([point[0] - r, point[1] - r, point[0] + r, point[1] + r], fill=color)


def draw_stroke(layer, pts, color, width, seed=0):
    """Tamamlanmış bir çizgiyi katmana çizer (değişken kalınlık + yumuşatma)."""
    draw = ImageDraw.Draw(layer)
    poly = stroke_polygon(pts, width, seed=seed)
    if not poly:
        return
    # Hafif dışa taşan, düşük alfalı ikinci geçiş: kenarları yumuşatır
    if width >= 4:
        soft = [(x + 0.8, y + 0.9) for x, y in poly]
        draw.polygon(soft, fill=tuple(color) + (90,))
    draw.polygon(poly, fill=tuple(color) + (255,))
    ink_blob(draw, pts[0], width, tuple(color) + (255,), seed=seed)
    if len(pts) > 2:
        ink_blob(draw, pts[-1], width * 0.8, tuple(color) + (255,), seed=seed + 1)


def draw_partial(layer, pts, color, width, progress, seed=0):
    """Çizilmekte olan darbenin görünen kısmını çizer; kalem ucunu döndürür."""
    visible = truncate(pts, progress)
    if len(visible) < 2:
        return visible[0] if visible else None
    draw = ImageDraw.Draw(layer)
    poly = stroke_polygon(visible, width, seed=seed)
    if poly:
        draw.polygon(poly, fill=tuple(color) + (255,))
    ink_blob(draw, visible[0], width, tuple(color) + (255,), seed=seed)
    return visible[-1]
