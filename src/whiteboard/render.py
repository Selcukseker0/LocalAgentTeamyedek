"""Beyaz tahta sahnelerini kare kare PNG'ye çevirir.

Kullanım:
    python render.py --manifest manifest.json --out frames_dir [--fps 30] [--size 1080x1920]

manifest.json biçimi:
    {"fps": 30, "width": 1080, "height": 1920,
     "scenes": [{"id": "egyptian_vase", "duration": 4.0, "text": "..."}, ...]}

Her sahne sıfırdan çizilir: kalem darbeleri sahne süresinin ilk %80'inde
ilerler, kalan %20'de bitmiş çizim ekranda kalır. Çizim sırasında gerçek
keçeli kalem tutan bir el (PNG sprite) kalem ucunu takip eder; referans
videodaki gibi sahne sonunda el kareyi terk eder.
"""

import argparse
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image, ImageDraw, ImageFilter  # noqa: E402

from scenes import SCENES, get_scene, pick_scene_for_text  # noqa: E402
from subtitles import SubtitleRenderer, parse_srt  # noqa: E402

DRAW_FRACTION = 0.8  # çizim, sahne süresinin bu kadarında biter

SKIN = (223, 176, 140)
SKIN_DARK = (188, 141, 108)
SKIN_LIGHT = (240, 199, 168)


def paper_background(w, h):
    """Referans videodaki gibi beyaz kâğıt + altta hafif gölge."""
    img = Image.new("RGB", (w, h), (252, 252, 250))
    draw = ImageDraw.Draw(img)

    for i in range(260):
        y = h - 260 + i
        shade = 252 - int(28 * (i / 260) ** 2)
        draw.line([(0, y), (w, y)], fill=(shade, shade, shade - 2))

    rnd = random.Random(42)
    for _ in range(2600):
        x, y = rnd.randrange(w), rnd.randrange(h)
        draw.point((x, y), fill=(246, 246, 244))
    return img


def _rounded(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def make_hand_sprite(scale=1.0):
    """Keçeli kalem tutan el sprite'ı üretir.

    Yerel koordinatlar: kalem ucu (0, 0) noktasında, gövde sağ-aşağı uzanır.
    Sprite geri döndürülmüş hâlde döner; çağıran taraf ucu hedef noktaya koyar.
    """
    sx = scale
    W, H = int(1000 * sx), int(900 * sx)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def P(x, y):
        return (x * sx, y * sx)

    def box(x1, y1, x2, y2):
        return [x1 * sx, y1 * sx, x2 * sx, y2 * sx]

    # --- Kalem ucu (siyah konik)
    d.polygon([P(6, 6), P(120, 52), P(104, 132)], fill=(24, 24, 24, 255))
    d.polygon([P(6, 6), P(118, 96), P(104, 132)], fill=(52, 52, 52, 255))

    # --- Kalem gövdesi (beyaz marker + siyah kapak)
    _rounded(d, box(112, 46, 430, 170), int(26 * sx), fill=(252, 252, 252, 255),
             outline=(30, 30, 30, 255), width=int(5 * sx))
    _rounded(d, box(380, 52, 470, 164), int(16 * sx), fill=(28, 28, 28, 255))
    d.line([P(150, 70), P(400, 70)], fill=(226, 226, 226, 255), width=int(6 * sx))

    # --- Başparmak
    _rounded(d, box(150, 118, 300, 236), int(48 * sx), fill=SKIN_LIGHT,
             outline=SKIN_DARK, width=int(4 * sx))
    d.line([P(300, 140), P(300, 220)], fill=SKIN_DARK, width=int(4 * sx))

    # --- Avuç
    d.ellipse(box(230, 140, 620, 470), fill=SKIN, outline=SKIN_DARK, width=int(4 * sx))

    # --- Parmaklar (kalemi kavrayan)
    for i, (x, y, rr) in enumerate([(300, 150, 70), (390, 165, 66), (470, 185, 60),
                                    (545, 215, 54)]):
        d.ellipse(box(x - rr, y - rr * 0.72, x + rr, y + rr * 0.72), fill=SKIN_LIGHT,
                  outline=SKIN_DARK, width=int(4 * sx))
        d.line([P(x - rr * 0.6, y + rr * 0.45), P(x + rr * 0.6, y + rr * 0.55)],
               fill=SKIN_DARK, width=int(3 * sx))

    # --- Bilek (kadrajın dışına uzar)
    d.polygon([P(430, 330), P(760, 300), P(980, 860), P(520, 900)], fill=SKIN,
              outline=SKIN_DARK)

    # Yumuşak gölge
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse(box(180, 150, 700, 520), fill=(0, 0, 0, 55))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(26 * sx)))
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.alpha_composite(shadow)
    out.alpha_composite(img)
    return out


def stroke_lengths(strokes):
    lengths = []
    for pts, _color, _width in strokes:
        total = 0.0
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            total += math.hypot(x2 - x1, y2 - y1)
        lengths.append(total)
    return lengths


def draw_progress(draw, strokes, lengths, progress, scale_x, scale_y):
    """progress (0..1) kadar çizimi yapar; kalem ucunun konumunu döndürür."""
    if progress <= 0:
        return None
    budget = progress * sum(lengths)
    tip = None
    for (pts, color, width), seg_len in zip(strokes, lengths):
        if budget <= 0:
            break
        scaled = [(x * scale_x, y * scale_y) for x, y in pts]
        w = max(1, int(width * scale_x))
        if seg_len <= budget:
            if width == 0:
                draw.polygon(scaled, fill=color)
            else:
                draw.line(scaled, fill=color, width=w, joint="curve")
            tip = scaled[-1]
            budget -= seg_len
        else:
            acc = 0.0
            partial = [scaled[0]]
            for (x1, y1), (x2, y2) in zip(scaled, scaled[1:]):
                seg = math.hypot(x2 - x1, y2 - y1)
                if acc + seg <= budget:
                    partial.append((x2, y2))
                    acc += seg
                else:
                    t = (budget - acc) / seg if seg else 0
                    partial.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
                    break
            if width == 0:
                if len(partial) >= 3:
                    draw.polygon(partial, fill=color)
            else:
                draw.line(partial, fill=color, width=w, joint="curve")
            tip = partial[-1]
            budget = 0
    return tip


def paste_hand(frame, sprite, anchor, offset=(0, 0)):
    """Sprite'ın kalem ucunu `anchor` noktasına getirerek yapıştırır."""
    x = int(anchor[0] + offset[0] - sprite["tip_x"])
    y = int(anchor[1] + offset[1] - sprite["tip_y"])
    if sprite.get("shadow") is not None:
        sx, sy = sprite["shadow_offset"]
        frame.alpha_composite(sprite["shadow"], (x + sx, y + sy))
    frame.alpha_composite(sprite["image"], (x, y))


ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
HAND_PNG = os.path.join(ASSETS, "hand_marker.png")
HAND_META = os.path.join(ASSETS, "hand_marker.json")


def load_hand(target_width):
    """Gerçekçi el sprite'ını yükler ve ölçekler.

    `assets/hand_marker.png` yoksa vektörel el ile devam eder.
    """
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
        # Kâğıda düşen yumuşak gölge
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
    return {"image": img, "shadow": None, "tip_x": 6 * (target_width / 1000.0),
            "tip_y": 6 * (target_width / 1000.0)}


def render(manifest_path, out_dir, fps, width, height, with_hand=True, srt_path=None):
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
    scale_x = width / 1080.0
    scale_y = height / 1920.0
    hand = load_hand(width * 0.66) if with_hand else None
    frame_idx = 0
    elapsed = 0.0

    for scene in scenes:
        scene_id = scene.get("id") or pick_scene_for_text(scene.get("text", ""))
        duration = float(scene.get("duration", 3.0))
        n_frames = max(1, int(round(duration * fps)))
        strokes = get_scene(scene_id)
        lengths = stroke_lengths(strokes)
        base = paper_background(width, height).convert("RGBA")
        scene_start = elapsed

        for i in range(n_frames):
            t = i / max(1, n_frames - 1)
            progress = min(1.0, t / DRAW_FRACTION)
            frame = base.copy()
            draw = ImageDraw.Draw(frame)
            tip = draw_progress(draw, strokes, lengths, progress, scale_x, scale_y)

            if hand:
                if progress < 1.0 and tip:
                    # Çizerken: kalem ucu hattın ucunda, hafif titrek
                    wobble = math.sin(i * 0.9) * 3 * scale_x
                    paste_hand(frame, hand, tip, offset=(wobble, wobble * 0.4))
                elif progress >= 1.0:
                    # Sahne sonunda el kareyi terk eder
                    leave = min(1.0, (t - DRAW_FRACTION) / (1 - DRAW_FRACTION))
                    if leave < 0.85:
                        last = lengths and strokes[-1][0][-1]
                        anchor = (last[0] * scale_x, last[1] * scale_y)
                        shift = leave * 1400 * scale_x
                        paste_hand(frame, hand, anchor, offset=(shift, shift * 0.9))

            if subs:
                subs.draw(frame, scene_start + i / fps)

            frame.convert("RGB").save(os.path.join(out_dir, f"frame_{frame_idx:05d}.png"))
            frame_idx += 1

        elapsed = scene_start + n_frames / fps

    print(f"OK {frame_idx} kare üretildi -> {out_dir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=False, help="Sahne manifestosu (JSON)")
    ap.add_argument("--out", required=False, help="Karelerin yazılacağı klasör")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--size", default="1080x1920")
    ap.add_argument("--srt", default=None, help="Altyazı dosyası (karelere gömülür)")
    ap.add_argument("--no-hand", action="store_true", help="El sprite'ını kapat")
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
           with_hand=not args.no_hand, srt_path=args.srt)


if __name__ == "__main__":
    main()
