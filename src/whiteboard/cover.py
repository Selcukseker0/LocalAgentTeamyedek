"""Kapak (thumbnail) üretir: 1080x1920, kâğıt zemin + çizim + büyük başlık.

Kullanım:
  python src/whiteboard/cover.py --frame kare.png --title "3000 YIL" \
      --subtitle "Bal hiç bozulmaz mı?" --out cover.jpg --size 1080x1920

Kapak, Shorts listesinde ilk izlenimi belirler: burada amaç büyük ve okunur
bir başlık + tek bir net çizim. Metin render edilirken karelere gömülmez,
sadece kapakta kullanılır.
"""

import argparse
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter  # noqa: E402
except ImportError:  # pragma: no cover - kullanıcıya anlaşılır mesaj
    raise SystemExit(
        "Pillow kurulu değil. Kurulum: python -m pip install -r requirements.txt"
    ) from None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ink import make_paper  # noqa: E402
from subtitles import find_font  # noqa: E402
from render import autocrop_white  # noqa: E402

BLACK = (22, 22, 22)
YELLOW = (242, 183, 5)


def wrap(draw, text, font, max_width):
    words = text.split()
    lines, current = [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        width = draw.textlength(candidate, font=font)
        if width <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def fit_font(size):
    """subtitles.find_font ile aynı aday listesini kullanır (yol değil, font döner)."""
    return find_font(size)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frame", required=True)
    parser.add_argument("--title", default="")
    parser.add_argument("--subtitle", default="")
    parser.add_argument("--out", required=True)
    parser.add_argument("--size", default="1080x1920")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    width, height = (int(v) for v in args.size.lower().split("x"))
    paper = make_paper(width, height, seed=args.seed).convert("RGB")

    source = Image.open(args.frame).convert("RGB")
    source = autocrop_white(source)

    # Görsel: üst %58'lik bant, kenarlardan boşluklu ve ortalanmış
    max_w, max_h = width * 0.88, height * 0.54
    ratio = min(max_w / source.width, max_h / source.height)
    size = (max(1, int(source.width * ratio)), max(1, int(source.height * ratio)))
    art = source.resize(size, Image.LANCZOS).filter(
        ImageFilter.UnsharpMask(radius=1.8, percent=120, threshold=3)
    )
    art_x = (width - size[0]) // 2
    art_y = int(height * 0.10)
    paper.paste(art, (art_x, art_y))

    draw = ImageDraw.Draw(paper)

    title = (args.title or "").strip().upper()
    subtitle = (args.subtitle or "").strip()

    # Başlık: sarı marker vurgusu + koyu metin (en fazla 3 satır)
    if title:
        title_font = fit_font(int(width * 0.115))
        max_text_w = width * 0.84
        while draw.textlength(title, font=title_font) > max_text_w and title_font.size > 40:
            title_font = fit_font(title_font.size - 6)

        lines = wrap(draw, title, title_font, max_text_w)[:3]
        line_h = int(title_font.size * 1.22)
        block_h = line_h * len(lines)
        top = int(height * 0.70)

        # Sarı vurgu bandı (elle çizilmiş gibi hafif eğik)
        pad = int(width * 0.035)
        band = [int(width * 0.06), top - pad, int(width * 0.94), top + block_h + pad]
        draw.rounded_rectangle(band, radius=int(width * 0.02), fill=YELLOW)

        y = top
        for line in lines:
            w = draw.textlength(line, font=title_font)
            draw.text(((width - w) / 2, y), line, font=title_font, fill=BLACK)
            y += line_h

        bottom_of_title = top + block_h

        if subtitle:
            sub_font = fit_font(int(width * 0.048))
            sub_lines = wrap(draw, subtitle, sub_font, max_text_w)[:2]
            y = bottom_of_title + int(height * 0.045)
            for line in sub_lines:
                w = draw.textlength(line, font=sub_font)
                draw.text(((width - w) / 2, y), line, font=sub_font, fill=(60, 60, 60))
                y += int(sub_font.size * 1.3)

    paper.save(args.out, quality=92)
    print(args.out)


if __name__ == "__main__":
    main()
