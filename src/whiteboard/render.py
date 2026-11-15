"""Beyaz tahta sahnelerini kare kare PNG'ye çevirir.

Kullanım:
    python render.py --manifest manifest.json --out frames_dir [--fps 30] [--size 1080x1920]

manifest.json biçimi:
    {"fps": 30, "width": 1080, "height": 1920,
     "scenes": [{"id": "egyptian_vase", "duration": 4.0, "text": "..."}, ...]}

Her sahne sıfırdan çizilir. Kalem darbeleri gerçek bir marker gibi:
değişken kalınlıkta, uç birikmeli, darbeler arasında kalem kalkıp yeni
konuma gider. Renk dolguları yarı saydam bantlarla, soldan sağa sürülerek
doldurulur. Çizim sahne süresinin ilk %82'sinde biter; sonra el kareyi
terk eder ve çizim kısa bir süre ekranda kalır.
"""

import argparse
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image, ImageChops, ImageDraw, ImageFilter  # noqa: E402

from ink import (  # noqa: E402
    draw_fill_reveal,
    draw_partial,
    draw_stroke,
    make_fill,
    make_paper,
    path_length,
    truncate,
)
from scenes import SCENES, compose, get_scene, pick_scene_for_text  # noqa: E402
from subtitles import SubtitleRenderer, parse_srt, find_font  # noqa: E402

DRAW_FRACTION = 0.88     # çizim, sahne süresinin bu kadarında tamamlanır
DRAW_SPEED = 1500.0      # çizim hızı (1080px tuvalde piksel/saniye)
TRAVEL_TIME = 0.15       # iki darbe arasında kalemin havada gidiş süresi
FILL_TIME = 0.75         # bir renk dolgusunun sürülme süresi
EXIT_TIME = 0.55         # sahne sonunda elin kareyi terk etme süresi

SKIN = (223, 176, 140)
SKIN_DARK = (188, 141, 108)
SKIN_LIGHT = (240, 199, 168)


def _rounded(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def make_hand_sprite(scale=1.0):
    """Yedek (vektörel) el sprite'ı — gerçek görsel yoksa kullanılır."""
    sx = scale
    W, H = int(1000 * sx), int(900 * sx)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def P(x, y):
        return (x * sx, y * sx)

    def box(x1, y1, x2, y2):
        return [x1 * sx, y1 * sx, x2 * sx, y2 * sx]

    d.polygon([P(6, 6), P(120, 52), P(104, 132)], fill=(24, 24, 24, 255))
    d.polygon([P(6, 6), P(118, 96), P(104, 132)], fill=(52, 52, 52, 255))
    _rounded(d, box(112, 46, 430, 170), int(26 * sx), fill=(252, 252, 252, 255),
             outline=(30, 30, 30, 255), width=int(5 * sx))
    _rounded(d, box(380, 52, 470, 164), int(16 * sx), fill=(28, 28, 28, 255))
    _rounded(d, box(150, 118, 300, 236), int(48 * sx), fill=SKIN_LIGHT,
             outline=SKIN_DARK, width=int(4 * sx))
    d.ellipse(box(230, 140, 620, 470), fill=SKIN, outline=SKIN_DARK, width=int(4 * sx))
    for x, y, rr in [(300, 150, 70), (390, 165, 66), (470, 185, 60), (545, 215, 54)]:
        d.ellipse(box(x - rr, y - rr * 0.72, x + rr, y + rr * 0.72), fill=SKIN_LIGHT,
                  outline=SKIN_DARK, width=int(4 * sx))
    d.polygon([P(430, 330), P(760, 300), P(980, 860), P(520, 900)], fill=SKIN,
              outline=SKIN_DARK)

    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse(box(180, 150, 700, 520), fill=(0, 0, 0, 55))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(26 * sx)))
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.alpha_composite(shadow)
    out.alpha_composite(img)
    return out


ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
HAND_PNG = os.path.join(ASSETS, "hand_marker.png")
HAND_META = os.path.join(ASSETS, "hand_marker.json")


def load_hand(target_width):
    """Gerçekçi el sprite'ını yükler ve ölçekler."""
    if os.path.exists(HAND_PNG):
        sprite = Image.open(HAND_PNG).convert("RGBA")
        meta = {"tip_x": 6, "tip_y": 6}
        if os.path.exists(HAND_META):
            with open(HAND_META, encoding="utf-8") as f:
                meta.update(json.load(f))
        factor = target_width / sprite.width
        sprite = sprite.resize(
            (max(1, int(sprite.width * factor)), max(1, int(sprite.height * factor))),
            Image.LANCZOS
        )
        sprite = extend_arm(sprite)
        shadow = Image.new("RGBA", sprite.size, (0, 0, 0, 0))
        shadow.putalpha(sprite.getchannel("A").point(lambda a: int(a * 0.30)))
        shadow = shadow.filter(ImageFilter.GaussianBlur(max(2, int(14 * factor))))
        return {
            "image": sprite,
            "shadow": shadow,
            "shadow_offset": (int(18 * factor), int(26 * factor)),
            "tip_x": meta["tip_x"] * factor,
            "tip_y": meta["tip_y"] * factor,
        }
    img = make_hand_sprite(target_width / 1000.0)
    scale = target_width / 1000.0
    return {"image": img, "shadow": None, "tip_x": 6 * scale, "tip_y": 6 * scale}


def extend_arm(img, y_frac=0.52, extra_ratio=1.15):
    """El sprite'ının kolunu aşağı doğru yumuşakça uzatır.

    Alt bölge dikeyde esnetilir; böylece ek yeri (dikiş) oluşmaz ve kalem
    karenin ortasında çizerken kol kadrajın dışına taşar.
    """
    w, h = img.size
    y0 = int(h * y_frac)
    new_h = h + int(h * extra_ratio)
    if y0 >= h - 2:
        return img

    out = Image.new("RGBA", (w, new_h), (0, 0, 0, 0))
    out.paste(img.crop((0, 0, w, y0)), (0, 0))
    lower = img.crop((0, y0, w, h)).resize((w, new_h - y0), Image.BICUBIC)
    out.alpha_composite(lower, (0, y0))

    # Yeni alt kenarda çok hafif sönümleme
    fade = Image.linear_gradient("L").resize((w, new_h), Image.BILINEAR)
    ramp = fade.point(lambda v: 255 if v < 205 else int(max(0, 255 - (v - 205) * 5.1)))
    out.putalpha(Image.composite(out.getchannel("A"), Image.new("L", (w, new_h), 0), ramp))
    return out


def make_variants(sprite, angles=(-7.0, 0.0, 6.0), scales=(0.96, 1.0, 1.05)):
    """Aynı el sprite'ından küçük açı/ölçek varyantları üretir.

    Her sahne farklı bir varyant kullanır; böylece aynı el tekrar ediyormuş
    hissi azalır. Döndürme kalem ucu etrafında yapılır, uç noktası korunur.
    """
    base_img = sprite["image"]
    tip = (sprite["tip_x"], sprite["tip_y"])
    pad = int(max(base_img.width, base_img.height) * 0.35)

    variants = []
    for angle in angles:
        for scale in scales:
            canvas = Image.new("RGBA", (base_img.width + pad * 2, base_img.height + pad * 2),
                               (0, 0, 0, 0))
            canvas.alpha_composite(base_img, (pad, pad))
            tip_pos = (tip[0] + pad, tip[1] + pad)
            rotated = canvas.rotate(angle, center=tip_pos, resample=Image.BICUBIC)
            if scale != 1.0:
                rotated = rotated.resize(
                    (int(rotated.width * scale), int(rotated.height * scale)), Image.LANCZOS
                )
                tip_pos = (tip_pos[0] * scale, tip_pos[1] * scale)
            bbox = rotated.getbbox()
            if not bbox:
                continue
            cropped = rotated.crop(bbox)
            variants.append({
                "image": cropped,
                "tip_x": tip_pos[0] - bbox[0],
                "tip_y": tip_pos[1] - bbox[1],
                "shadow": None,
            })

    out = []
    for v in variants:
        shadow = Image.new("RGBA", v["image"].size, (0, 0, 0, 0))
        shadow.putalpha(v["image"].getchannel("A").point(lambda a: int(a * 0.28)))
        shadow = shadow.filter(ImageFilter.GaussianBlur(8))
        v["shadow"] = shadow
        v["shadow_offset"] = (10, 14)
        out.append(v)
    return out or [sprite]


def paste_hand(frame, sprite, anchor, offset=(0, 0)):
    """Sprite'ın kalem ucunu `anchor` noktasına getirerek yapıştırır."""
    x = int(anchor[0] + offset[0] - sprite["tip_x"])
    y = int(anchor[1] + offset[1] - sprite["tip_y"])
    if sprite.get("shadow") is not None:
        sx, sy = sprite["shadow_offset"]
        frame.alpha_composite(sprite["shadow"], (x + sx, y + sy))
    frame.alpha_composite(sprite["image"], (x, y))


def _ease_in_out(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)



def autocrop_white(img, padding=18):
    """Beyaz kenar boşluklarını kırpar (üretilen görsellerde sık görülür)."""
    rgb = img.convert("RGB")
    diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, (255, 255, 255)))
    bbox = diff.getbbox()
    if not bbox or bbox == (0, 0, rgb.width, rgb.height):
        return rgb
    left, top, right, bottom = bbox
    left = max(0, left - padding)
    top = max(0, top - padding)
    right = min(rgb.width, right + padding)
    bottom = min(rgb.height, bottom + padding)
    if right - left < 80 or bottom - top < 80:
        return rgb
    return rgb.crop((left, top, right, bottom))


def split_line_and_color(img):
    """Üretilmiş illüstrasyonu siyah kontur ve renk dolgusu katmanlarına ayırır.

    Beyaz zemin şeffaf olur; koyu pikseller çizgi katmanına, doygun (renkli)
    pikseller boya katmanına gider. Böylece görsel önce kontur gibi "çizilip"
    ardından renkleri boyanabilir.
    """
    rgb = img.convert("RGB")
    lum = rgb.convert("L")
    sat = rgb.convert("HSV").getchannel("S")

    dark = lum.point(lambda v: 255 if v < 115 else 0)
    not_white = lum.point(lambda v: 255 if v < 244 else 0)
    not_dark = dark.point(lambda v: 0 if v else 255)
    colorful = sat.point(lambda v: 255 if v > 30 else 0)

    # Kenar yumuşaklığı için çok koyu olmayan ama açık da olmayan pikseller
    # hafif saydam çizgi olarak alınır (bant etkisi vermesin diye dar aralık)
    line_mask = ImageChops.lighter(dark, lum.point(lambda v: 60 if v < 148 else 0))
    color_mask = ImageChops.multiply(ImageChops.multiply(not_white, colorful), not_dark)

    line = rgb.copy()
    line.putalpha(line_mask)
    color = rgb.copy()
    color.putalpha(color_mask)
    return line, color


class ImageSceneRenderer:
    """Hazır bir illüstrasyonu maske ile çizip sonra renklerini boyar.

    - Sahne süresinin ilk %68'inde siyah konturlar yukarıdan aşağıya açılır,
      kalem ucu açılma sınırını takip eder.
    - Kalan sürede renk katmanı soldan sağa süpürülerek (fırça gibi) dolar.
    """

    LINE_PHASE = 0.68
    COLOR_PHASE = 0.24
    EXIT_TIME = 0.45
    MAX_WIDTH_RATIO = 0.86
    MAX_HEIGHT_RATIO = 0.56

    def __init__(self, image_path, duration, fps, width, height, hand, seed=0, has_label=False):
        self.width = width
        self.height = height
        self.fps = fps
        self.duration = max(0.8, float(duration))
        self.n_frames = max(1, int(round(self.duration * fps)))
        self.hand = hand
        self.paper = make_paper(width, height, seed=19 + seed * 5).convert("RGBA")

        source = Image.open(image_path).convert("RGB")
        # Beyaz kenar boşluklarını kırp: görsel alanı doldursun
        source = autocrop_white(source)
        max_w = width * self.MAX_WIDTH_RATIO
        # Üstte bant yazısı, altta altyazı için boşluk bırakılır
        top_limit = height * (0.215 if has_label else 0.125)
        bottom_limit = height * 0.70
        avail_h = max(120.0, bottom_limit - top_limit)

        ratio = min(max_w / source.width, avail_h / source.height)
        size = (max(1, int(source.width * ratio)), max(1, int(source.height * ratio)))
        resized = source.resize(size, Image.LANCZOS)

        self.size = size
        self.line_layer, self.color_layer = split_line_and_color(resized)
        self.pos = ((width - size[0]) // 2, int(top_limit + (avail_h - size[1]) / 2))
        self.line_end = self.duration * self.LINE_PHASE
        self.color_end = self.line_end + self.duration * self.COLOR_PHASE

    # ------------------------------------------------------------- yardımcı

    def _scan_mask(self, progress):
        """Üstten aşağıya açılan maske (kenarı yumuşak)."""
        mask = Image.new("L", self.size, 0)
        draw = ImageDraw.Draw(mask)
        frontier = progress * self.size[1]
        solid = int(max(0, frontier - 12))
        if solid > 0:
            draw.rectangle([0, 0, self.size[0], solid], fill=255)
        band = 24
        for i in range(band):
            y = solid + i
            if y >= self.size[1]:
                break
            value = int(255 * (i / band))
            draw.rectangle([0, y, self.size[0], y + 1], fill=value)
        return mask, frontier

    def _brush_mask(self, progress):
        """Soldan sağa süpüren boya maskesi (dikey yumuşak kenar)."""
        mask = Image.new("L", self.size, 0)
        draw = ImageDraw.Draw(mask)
        frontier = progress * self.size[0]
        solid = int(max(0, frontier - 20))
        if solid > 0:
            draw.rectangle([0, 0, solid, self.size[1]], fill=255)
        band = 40
        for i in range(band):
            x = solid + i
            if x >= self.size[0]:
                break
            value = int(255 * (i / band))
            draw.rectangle([x, 0, x + 1, self.size[1]], fill=value)
        return mask, frontier

    # ------------------------------------------------------------- kare

    def frame(self, t):
        frame = self.paper.copy()
        line_progress = min(1.0, t / self.line_end) if self.line_end else 1.0
        eased = _ease_in_out(line_progress)

        mask, frontier = self._scan_mask(eased)
        line = self.line_layer.copy()
        line.putalpha(ImageChops.multiply(self.line_layer.getchannel("A"), mask))
        frame.alpha_composite(line, self.pos)

        color_progress = 0.0
        if t > self.line_end:
            color_progress = min(1.0, (t - self.line_end) / max(0.01, self.color_end - self.line_end))
            brush, _fx = self._brush_mask(_ease_in_out(color_progress))
            color = self.color_layer.copy()
            color.putalpha(ImageChops.multiply(self.color_layer.getchannel("A"), brush))
            frame.alpha_composite(color, self.pos)

        tip = None
        if t <= self.line_end:
            tip = (self.pos[0] + self.size[0] * 0.5,
                   self.pos[1] + min(self.size[1] - 2, frontier))
        elif t <= self.color_end:
            tip = (self.pos[0] + self.size[0] * color_progress * 0.92,
                   self.pos[1] + self.size[1] * 0.62)
        if self.hand is not None:
            if tip is not None:
                wobble = math.sin(t * 8.0) * 2.4
                paste_hand(frame, self.hand, tip, offset=(wobble, wobble * 0.3))
            else:
                leave = (t - self.color_end) / self.EXIT_TIME if self.color_end else 1.0
                if leave < 1.0:
                    e = _ease_in_out(min(1.0, leave))
                    paste_hand(frame, self.hand,
                               (self.pos[0] + self.size[0] * 0.9, self.pos[1] + self.size[1] * 0.62),
                               offset=(e * 900 * (self.width / 1080), e * 820 * (self.height / 1920)))
        return frame


class SceneRenderer:
    """Bir sahnenin kare kare çizimini yönetir."""

    def __init__(self, scene_id, duration, fps, width, height, hand, seed=0, objects=None):
        self.width = width
        self.height = height
        self.fps = fps
        self.duration = duration
        self.n_frames = max(1, int(round(duration * fps)))
        self.scale_x = width / 1080.0
        self.scale_y = height / 1920.0
        self.hand = hand

        # Kompozisyon verilmişse sahne nesnelerden kurulur (cümlenin anlamına göre)
        composed = compose(objects) if objects else []
        raw = composed if composed else get_scene(scene_id)
        self.paper = make_paper(width, height, seed=13 + seed * 7).convert("RGBA")

        rnd = random.Random(seed * 31 + 5)
        self.items = []
        for idx, (pts, color, width_px) in enumerate(raw):
            scaled = [(x * self.scale_x, y * self.scale_y) for x, y in pts]
            if width_px == 0:
                xs = [p[0] for p in scaled]
                ys = [p[1] for p in scaled]
                pad = 10
                bbox = (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)
                fx, fy, sprite, axis = make_fill(bbox, scaled, color, seed=idx)
                self.items.append({
                    "kind": "fill",
                    "bbox": (fx, fy, fx + sprite.width, fy + sprite.height),
                    "sprite": (fx, fy, sprite, axis),
                    "start": scaled[0],
                    "end": scaled[0],
                    "draw_time": FILL_TIME,
                    "length": 0.0,
                })
            else:
                self.items.append({
                    "kind": "stroke",
                    "pts": scaled,
                    "color": tuple(color),
                    "width": width_px * self.scale_x * rnd.uniform(0.92, 1.08),
                    "seed": idx * 17 + 3,
                    "start": scaled[0],
                    "end": scaled[-1],
                    "length": path_length(scaled),
                    "draw_time": max(0.22, path_length(scaled) / (DRAW_SPEED * self.scale_x)),
                })

        # Zamanlama: kalem havada gezinme + çizim süreleri
        raw_total = 0.0
        for i, item in enumerate(self.items):
            travel = 0.0
            if i > 0:
                dist = math.hypot(item["start"][0] - self.items[i - 1]["end"][0],
                                  item["start"][1] - self.items[i - 1]["end"][1])
                travel = min(0.32, TRAVEL_TIME + dist / (4200.0 * self.scale_x))
            item["travel"] = travel
            raw_total += travel + item["draw_time"]

        budget = max(0.6, DRAW_FRACTION * duration)
        fit = budget / raw_total if raw_total > 0 else 1.0
        # Her sahne kendi süresi içinde bitmeli: alt sınır çok düşük tutulur
        fit = min(2.5, max(0.02, fit))

        # Sahne başında el kadraja girer
        self.entry_time = min(0.45, duration * 0.12) if hand is not None else 0.0
        t = self.entry_time
        for item in self.items:
            t += item["travel"] * fit
            item["t_start"] = t
            t += item["draw_time"] * fit
            item["t_end"] = t
        self.draw_end = t

        # Tamamlanan darbeler için katman
        self.done_layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        self.done_upto = 0

    # ---------------------------------------------------------------- zaman

    def state_at(self, t):
        """(index, mod, oran) döndürür. mod: 'entry' | 'travel' | 'draw' | 'hold'."""
        if t < getattr(self, "entry_time", 0.0):
            return 0, "entry", t / self.entry_time if self.entry_time else 1.0
        for i, item in enumerate(self.items):
            if t < item["t_start"]:
                return i, "travel", 0.0 if item["travel"] <= 0 else 1.0
            if t < item["t_end"]:
                span = item["t_end"] - item["t_start"]
                return i, "draw", (t - item["t_start"]) / span if span > 0 else 1.0
        return len(self.items), "hold", 1.0

    def _complete_until(self, index):
        """`index`'e kadar olan darbeleri kalıcı katmana işler."""
        while self.done_upto < index and self.done_upto < len(self.items):
            item = self.items[self.done_upto]
            if item["kind"] == "fill":
                fx, fy, sprite = item["sprite"][:3]
                self.done_layer.alpha_composite(sprite, (fx, fy))
            else:
                draw_stroke(self.done_layer, item["pts"], item["color"],
                            item["width"], seed=item["seed"])
            self.done_upto += 1

    # ---------------------------------------------------------------- çizim

    def _tip_for(self, index, mode, frac):
        """Kalem ucunun o andaki konumu (ve elin havada olup olmadığı)."""
        if mode == "entry":
            target = self.items[0]["start"] if self.items else (self.width / 2, self.height / 2)
            start = (self.width * 0.82, self.height * 1.04)
            e = _ease_in_out(frac)
            return (start[0] + (target[0] - start[0]) * e,
                    start[1] + (target[1] - start[1]) * e)

        if index <= 0 and mode != "draw":
            return self.items[0]["start"] if self.items else (self.width / 2, self.height / 2)

        if mode == "draw":
            item = self.items[index]
            if item["kind"] == "fill":
                x0, y0, x1, y1 = item["bbox"]
                return (x0 + (x1 - x0) * min(1.0, frac), y0 + (y1 - y0) * 0.55)
            vis = truncate(item["pts"], frac)
            return vis[-1] if vis else item["start"]

        # travel: bir önceki darbenin bitişinden yenisinin başına
        if index >= len(self.items):
            return None
        prev_end = self.items[index - 1]["end"] if index > 0 else self.items[0]["start"]
        nxt = self.items[index]["start"]
        e = _ease_in_out(frac)
        lift = math.sin(math.pi * min(1.0, frac)) * 16 * self.scale_x  # kalem havada
        return (prev_end[0] + (nxt[0] - prev_end[0]) * e - lift * 0.5,
                prev_end[1] + (nxt[1] - prev_end[1]) * e - lift)

    def frame(self, t):
        self._complete_until(self.state_at(t)[0])

        frame = self.paper.copy()
        if self.done_upto > 0:
            frame.alpha_composite(self.done_layer)

        index, mode, frac = self.state_at(t)

        if mode == "draw" and index < len(self.items):
            item = self.items[index]
            if item["kind"] == "fill":
                draw_fill_reveal(frame, item["sprite"], frac)
            else:
                visible = truncate(item["pts"], frac)
                if visible:
                    xs = [p[0] for p in visible]
                    ys = [p[1] for p in visible]
                    m = int(item["width"] * 3 + 24)
                    bx, by = int(min(xs) - m), int(min(ys) - m)
                    tile = Image.new("RGBA",
                                     (int(max(xs) - min(xs) + 2 * m), int(max(ys) - min(ys) + 2 * m)),
                                     (0, 0, 0, 0))
                    draw_partial(tile, visible, item["color"], item["width"], 1.0,
                                 seed=item["seed"])
                    frame.alpha_composite(tile, (bx, by))

        if self.hand is not None:
            tip = self._tip_for(index, mode, frac)
            if mode == "hold":
                # Sahne sonu: el kareyi yumuşak bir hareketle terk eder
                leave = (t - self.draw_end) / EXIT_TIME if self.draw_end else 1.0
                if leave < 1.0 and self.items:
                    last = self.items[-1]["end"]
                    e = _ease_in_out(leave)
                    paste_hand(frame, self.hand, last,
                               offset=(e * 900 * self.scale_x, e * 780 * self.scale_y))
            elif tip is not None:
                wobble = math.sin(t * 9.0) * 2.2 * self.scale_x
                paste_hand(frame, self.hand, tip, offset=(wobble, wobble * 0.35))

        return frame


def make_sheet(frame_paths, out_path, thumb_w=432):
    """Karelerden 4'lük bir önizleme (contact sheet) üretir."""
    if not frame_paths:
        return None
    # İlk/son kareler boş kâğıt ya da bitmiş çizim olabilir; aralardan seç
    fractions = (0.15, 0.4, 0.65, 0.9)
    picks = [frame_paths[min(len(frame_paths) - 1, int(f * len(frame_paths)))]
             for f in fractions]
    thumbs = []
    for fp in picks:
        img = Image.open(fp)
        ratio = thumb_w / img.width
        thumbs.append(img.resize((thumb_w, int(img.height * ratio)), Image.LANCZOS))
    height = max(t.height for t in thumbs)
    sheet = Image.new("RGB", (thumb_w * len(thumbs), height), (255, 255, 255))
    for i, t in enumerate(thumbs):
        sheet.paste(t, (i * thumb_w, 0))
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    sheet.save(out_path, quality=88)
    return out_path



# --------------------------------------------------------------------- etiket
# Beyaz tahtaya yazılan kısa başlık ("3000 YIL", "SU YOK" gibi).
# Her sahne için bir kez üretilip önbelleğe alınır: kare başına maliyet ~0.
_LABEL_CACHE = {}


def board_label(text, width, height):
    """Sahne etiketini marker yazısı gibi hazırlar (saydam katman)."""
    key = (text, width, height)
    cached = _LABEL_CACHE.get(key)
    if cached is not None:
        return cached

    font = find_font(int(width * 0.072))
    probe = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    bbox = probe.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    pad = int(width * 0.04)
    layer_w = min(width - pad * 2, max(int(text_w + pad * 2), int(width * 0.3)))
    layer_h = int(text_h + width * 0.09)
    layer = Image.new("RGBA", (layer_w, layer_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    x = (layer_w - text_w) // 2 - bbox[0]
    draw.text((x, -bbox[1]), text, font=font, fill=(22, 22, 22, 240))

    # Altına hafif el çizimi çizgi
    import random as _random
    rnd = _random.Random(len(text) * 7 + layer_w)
    y = layer_h - int(width * 0.045)
    pts = []
    for i in range(0, 41):
        px = int(pad + (text_w + pad * 0.2) * i / 40)
        pts.append((px, y + rnd.randint(-2, 2)))
    draw.line(pts, fill=(22, 22, 22, 200), width=max(3, int(width * 0.006)), joint="curve")

    layer = layer.rotate(-1.8, resample=Image.BICUBIC, expand=False)
    _LABEL_CACHE[key] = layer
    return layer


def render(manifest_path, out_dir, fps, width, height, with_hand=True, srt_path=None,
           sheet_path=None, frame_format="jpg"):
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)

    subs = None
    if srt_path and os.path.exists(srt_path):
        with open(srt_path, encoding="utf-8") as f:
            cues = parse_srt(f.read())
        if cues:
            subs = SubtitleRenderer(cues, width, height)

    scenes = manifest.get("scenes", [])
    if not scenes:
        raise SystemExit("manifest içinde sahne yok")

    os.makedirs(out_dir, exist_ok=True)
    hand_variants = make_variants(load_hand(width * 0.56)) if with_hand else []
    frame_idx = 0
    elapsed = 0.0
    written = []

    for scene_no, scene in enumerate(scenes):
        scene_id = scene.get("id") or pick_scene_for_text(scene.get("text", ""))
        duration = float(scene.get("duration", 3.0))
        hand = hand_variants[scene_no % len(hand_variants)] if hand_variants else None
        image_path = scene.get("image")
        if image_path and os.path.exists(image_path):
            renderer = ImageSceneRenderer(image_path, duration, fps, width, height, hand,
                                          seed=scene_no, has_label=bool(scene.get("label")))
        else:
            renderer = SceneRenderer(scene_id, duration, fps, width, height, hand,
                                     seed=scene_no, objects=scene.get("objects"))

        label = scene.get("label") or ""
        label_layer = board_label(label, width, height) if label else None

        for i in range(renderer.n_frames):
            t = i / fps
            frame = renderer.frame(t)
            if label_layer is not None:
                frame.paste(label_layer, ((width - label_layer.width) // 2,
                                          int(height * 0.115)), label_layer)
            if subs:
                subs.draw(frame, elapsed + t)
            out_file = os.path.join(out_dir, f"frame_{frame_idx:05d}.{frame_format}")
            rgb = frame.convert("RGB")
            if frame_format == "png":
                # PNG kodlaması kare çiziminden pahalı; hız için düşük sıkıştırma
                rgb.save(out_file, compress_level=1)
            else:
                # JPEG q=95 4:4:4: çizgi sanatı için görsel olarak kayıpsıza yakın,
                # PNG'den ~7 kat hızlı (45 sn video için ~2-3 dakika kazanç)
                rgb.save(out_file, quality=95, subsampling=0)
            written.append(out_file)
            frame_idx += 1

        elapsed += renderer.n_frames / fps

    if sheet_path:
        sheet = make_sheet(written, sheet_path)
        if sheet:
            print(f"Önizleme: {sheet}")
    print(f"OK {frame_idx} kare üretildi -> {out_dir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=False, help="Sahne manifestosu (JSON)")
    ap.add_argument("--out", required=False, help="Karelerin yazılacağı klasör")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--size", default="1080x1920")
    ap.add_argument("--srt", default=None, help="Altyazı dosyası (karelere gömülür)")
    ap.add_argument("--no-hand", action="store_true", help="El sprite'ını kapat")
    ap.add_argument("--sheet", default=None, help="Önizleme görseli (4 kare) yolu")
    ap.add_argument("--format", default="jpg", choices=["jpg", "png"],
                    help="Kare biçimi (varsayılan jpg: hızlı, png: kayıpsız/yavaş)")
    ap.add_argument("--list-scenes", action="store_true",
                    help="Kullanılabilir sahne kimliklerini JSON olarak yaz")
    args = ap.parse_args()

    if args.list_scenes:
        print(json.dumps(sorted(SCENES.keys())))
        return
    if not args.manifest or not args.out:
        ap.error("--manifest ve --out gerekli")

    w, h = args.size.lower().split("x")
    render(args.manifest, args.out, args.fps, int(w), int(h),
           with_hand=not args.no_hand, srt_path=args.srt, sheet_path=args.sheet,
           frame_format=args.format)


if __name__ == "__main__":
    main()
