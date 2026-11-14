"""Chroma-key'li el görselini alfa kanallı PNG'ye çevirir.

`assets/hand_marker_raw.png` (düz yeşil zemin) -> `assets/hand_marker.png`

Çıktı: kalem ucu (0,0) noktasına taşınmış, kenarları yumuşatılmış sprite +
`assets/hand_marker.json` (uç noktası bilgisi).

Yeniden üretmek için:
    python src/whiteboard/prepare_hand.py
"""

import json
import os

from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
RAW = os.path.join(ASSETS, "hand_marker_raw.png")
OUT = os.path.join(ASSETS, "hand_marker.png")
META = os.path.join(ASSETS, "hand_marker.json")


def chroma_key(img):
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, _a = px[x, y]
            # Yeşil baskınlığı: zemin ne kadar yeşilse o kadar saydam
            dominance = g - max(r, b)
            if dominance > 60:
                px[x, y] = (r, g, b, 0)
            elif dominance > 18:
                alpha = int(255 * (1 - (dominance - 18) / 42))
                # Yeşil taşmasını bastır
                g2 = int(g - dominance * 0.85)
                px[x, y] = (r, max(0, g2), b, alpha)
    return img


def trim_to_tip(img):
    """Şeffaf kenarları kırpar, kalem ucunu sol-üste taşır."""
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)

    px = img.load()
    w, h = img.size
    tip = None
    best = None
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 200:
                score = x + y
                if best is None or score < best:
                    best, tip = score, (x, y)
    if tip is None:
        raise SystemExit("El sprite'ında opak piksel bulunamadı.")

    pad = 6
    canvas = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
    canvas.paste(img, (pad - tip[0], pad - tip[1]))
    return canvas, (pad, pad)


def main():
    if not os.path.exists(RAW):
        raise SystemExit(f"Ham görsel yok: {RAW}")
    keyed = chroma_key(Image.open(RAW))
    # Kenarları 1px yumuşat
    alpha = keyed.getchannel("A").filter(ImageFilter.GaussianBlur(0.6))
    keyed.putalpha(alpha)

    sprite, (tx, ty) = trim_to_tip(keyed)
    # Shorts için makul boyut (kalem ucu 1080px tuvalde ~6px pay)
    sprite.save(OUT)
    with open(META, "w", encoding="utf-8") as f:
        json.dump({"tip_x": tx, "tip_y": ty, "width": sprite.width, "height": sprite.height},
                  f, indent=2)
    print(f"OK {OUT} {sprite.size} tip=({tx},{ty})")


if __name__ == "__main__":
    main()
